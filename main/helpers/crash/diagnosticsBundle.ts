/**
 * 诊断包的收集、拼装与写入（纯逻辑 + zip；不依赖 electron，便于单测）。
 *
 * 数据来源全部经 DiagnosticsSources 注入：真实实现在 ipcDiagnosticsHandlers.ts，
 * 单测用假数据走完“收集 → 拼装 → 写 zip → 解开校验”整条链路。
 *
 * 隐私边界（均有单测）：
 * - 设置只导出白名单键；路径类只给“是否自定义 / 是否含非 ASCII / 是否含空格”，不导出值；
 * - 日志逐行经 sanitize（API Key 等）与 redact（用户目录 → ~）；
 * - 转储默认只带摘要（异常码、故障模块、CPU 型号、模块名），原始 .dmp 需显式勾选；
 * - 收集过程中任何一部分失败，只在该部分写入错误说明，其它部分照常导出——
 *   应用刚崩溃过时，诊断包恰恰最需要在“半坏”的环境里也能生成。
 */
import fs from 'fs';
import path from 'path';
import { ZipFile } from 'yazl';
import type { MinidumpSummary } from './minidumpSummary';
import type {
  DiagnosticsDumpPreview,
  DiagnosticsPreview,
} from '../../../types/diagnostics';

export const LOG_RETENTION_DAYS = 7;
/** 单日日志超过这个大小时只取尾部（最近的内容最有用），并在清单里标注已截断。 */
export const MAX_LOG_BYTES_PER_DAY = 20 * 1024 * 1024;

export interface DiagnosticsSources {
  now: number;
  appVersion: string;
  crashReporterEnabled: boolean;
  /** 日志文件列表，日期降序 */
  listLogFiles(): Promise<Array<{ date: string; size: number }>>;
  readLog(
    date: string,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean } | null>;
  readCrashEvents(): Promise<{
    current: string | null;
    rotated: string | null;
  }>;
  listDumps(): Array<{ file: string; size: number; mtimeMs: number }>;
  summarizeDump(file: string): MinidumpSummary | null;
  system(): Promise<unknown>;
  gpu(): Promise<unknown>;
  settings(): { settings: unknown; userConfig: unknown };
  addon(): unknown;
}

export interface DiagnosticsDump {
  /** 文件名（不含目录） */
  name: string;
  /** 磁盘路径：只用于读取原始转储，不会写进包里 */
  file: string;
  size: number;
  mtimeMs: number;
  summary: MinidumpSummary | null;
}

export interface DiagnosticsInput {
  now: number;
  appVersion: string;
  logs: Array<{ date: string; text: string; truncated: boolean }>;
  crashEvents: { current: string | null; rotated: string | null };
  dumps: DiagnosticsDump[];
  system: unknown;
  gpu: unknown;
  settings: unknown;
  addon: unknown;
  /** 收集失败的部分，形如 "gpu: timeout" */
  collectErrors: string[];
}

export interface BundleOptions {
  includeRawDumps: boolean;
  /** 敏感值脱敏（API Key 等），即 utils.sanitizeLogMessage */
  sanitize: (text: string) => string;
  /** 用户目录 → ~ */
  redact: (text: string) => string;
}

export type BundleEntry =
  | { name: string; content: string; mtime: Date }
  | { name: string; filePath: string; mtime: Date };

export interface BundleManifest {
  format: 1;
  generatedAt: string;
  appVersion: string;
  logDays: string[];
  logsTruncated: string[];
  crashEventLines: number;
  dumpSummaries: number;
  rawDumps: string[];
  collectErrors: string[];
  files: Array<{ name: string; bytes: number }>;
}

export interface BuildResult {
  root: string;
  entries: BundleEntry[];
  manifest: BundleManifest;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时区的 YYYYMMDD-HHmmss，用在文件名里。 */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function diagnosticsRootName(now: number): string {
  return `smartsub-diagnostics-${formatStamp(now)}`;
}

export function diagnosticsFileName(now: number): string {
  return `${diagnosticsRootName(now)}.zip`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/** 递归地对所有字符串值应用 fn；键名保持不变。 */
export function mapStringsDeep(
  value: unknown,
  fn: (text: string) => string,
  depth = 12,
): unknown {
  if (typeof value === 'string') return fn(value);
  if (depth <= 0 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => mapStringsDeep(item, fn, depth - 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = mapStringsDeep(item, fn, depth - 1);
  }
  return out;
}

/** 把多行折成单行：保持 JSONL 一行一条。 */
function collapseLines(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ');
}

/**
 * 应用日志（每天一个 JSONL）：逐行解析，只处理 message，再整行写回。
 * 不能整行丢给 sanitize——它会把整行当成 JSON 对象并缩进重排，破坏一行一条。
 * 坏行（崩溃时写到一半）不丢，按文本脱敏后折成单行保留。
 */
export function sanitizeLogJsonl(
  text: string,
  options: Pick<BundleOptions, 'sanitize' | 'redact'>,
): string {
  const { sanitize, redact } = options;
  const clean = (s: string) => redact(sanitize(s));
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        // 所有字符串字段都处理（不只 message）：别的字段里同样可能带用户目录
        out.push(JSON.stringify(mapStringsDeep(parsed, clean)));
        continue;
      }
    } catch {
      // 落到下面的文本处理
    }
    out.push(collapseLines(clean(line)));
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/** crash-events.jsonl：写入时已脱敏，这里再对所有字符串做一遍（纵深防御）。 */
export function sanitizeEventsJsonl(
  text: string,
  options: Pick<BundleOptions, 'sanitize' | 'redact'>,
): { text: string; lines: number } {
  const clean = (s: string) => options.redact(options.sanitize(s));
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.stringify(mapStringsDeep(JSON.parse(line), clean)));
    } catch {
      out.push(collapseLines(clean(line)));
    }
  }
  return { text: out.length ? `${out.join('\n')}\n` : '', lines: out.length };
}

// ---------------------------------------------------------------------------
// 设置快照（白名单）
// ---------------------------------------------------------------------------

/** settings 里可以原样导出的键：全是开关、枚举和数值，没有路径、地址、凭据。 */
const SETTINGS_PLAIN_KEYS = [
  'language',
  'useLocalWhisper',
  'useCuda',
  'gpuMode',
  'macAccelMode',
  'maxContext',
  'useVAD',
  'vadThreshold',
  'vadMinSpeechDuration',
  'vadMinSilenceDuration',
  'vadMaxSpeechDuration',
  'vadSpeechPad',
  'vadSamplesOverlap',
  'reduceRepetition',
  'fasterWhisperDevice',
  'fasterWhisperComputeType',
  'funasrProvider',
  'funasrUseItn',
  'funasrNumThreads',
  'qwenProvider',
  'qwenNumThreads',
  'fireRedProvider',
  'fireRedNumThreads',
  'parakeetProvider',
  'parakeetNumThreads',
  'proxyMode',
  'closeAction',
  'preventSleepDuringTask',
  'checkUpdateOnStartup',
  'useCustomTempDir',
  'taskViewMode',
  'videoDownloadQuality',
  'videoDownloadEngine',
  'videoDownloadConcurrency',
] as const;

/** 路径类设置：只说明“有没有自定义、会不会因为非 ASCII / 空格出问题”，不导出路径本身。 */
const SETTINGS_PATH_KEYS = [
  'storageRoot',
  'modelsPath',
  'customTempDir',
  'fasterWhisperModelsPath',
  'funasrModelsPath',
  'qwenModelsPath',
  'fireRedModelsPath',
  'parakeetModelsPath',
  'ttsModelsPath',
] as const;

/** userConfig（上次使用的任务配置）里与引擎和流程有关的键。 */
const USER_CONFIG_KEYS = [
  'sourceLanguage',
  'targetLanguage',
  'transcriptionEngine',
  'model',
  'useEmbeddedSubtitles',
  'translateContent',
  'maxConcurrentTasks',
  'subtitleOutputFormat',
  'speakerDiarization',
  'speakerDiarizationCount',
  'subtitleOutcome',
] as const;

const MAX_PLAIN_STRING = 64;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 只放行原始类型；字符串截断。对象 / 数组即使挂在白名单键下也丢弃，防止夹带凭据。 */
function plainValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_PLAIN_STRING);
  return undefined;
}

export function describePathSetting(value: unknown): {
  set: boolean;
  nonAscii: boolean;
  hasSpace: boolean;
} {
  if (typeof value !== 'string' || !value.trim()) {
    return { set: false, nonAscii: false, hasSpace: false };
  }
  return {
    set: true,
    // eslint-disable-next-line no-control-regex
    nonAscii: /[^\x00-\x7F]/.test(value),
    hasSpace: /\s/.test(value),
  };
}

export function buildSettingsSnapshot(
  settings: unknown,
  userConfig: unknown,
): Record<string, unknown> {
  const s = asRecord(settings);
  const plain: Record<string, unknown> = {};
  for (const key of SETTINGS_PLAIN_KEYS) {
    const value = plainValue(s[key]);
    if (value !== undefined) plain[key] = value;
  }

  const paths: Record<string, unknown> = {};
  for (const key of SETTINGS_PATH_KEYS) {
    paths[key] = describePathSetting(s[key]);
  }

  const last = asRecord(s.lastUsedTranscription);
  const lastUsedTranscription =
    typeof last.engine === 'string'
      ? {
          engine: last.engine.slice(0, MAX_PLAIN_STRING),
          ...(typeof last.model === 'string'
            ? { model: last.model.slice(0, MAX_PLAIN_STRING) }
            : {}),
        }
      : undefined;

  const u = asRecord(userConfig);
  const task: Record<string, unknown> = {};
  for (const key of USER_CONFIG_KEYS) {
    const value = plainValue(u[key]);
    if (value !== undefined) task[key] = value;
  }

  return {
    settings: plain,
    pathSettings: paths,
    ...(lastUsedTranscription ? { lastUsedTranscription } : {}),
    lastTaskConfig: task,
  };
}

// ---------------------------------------------------------------------------
// 收集
// ---------------------------------------------------------------------------

/** 成功返回值；失败时记录一条错误并返回 { error }，不抛。 */
async function settle<T>(
  label: string,
  errors: string[],
  run: () => Promise<T> | T,
): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    const message = errorMessage(error);
    errors.push(`${label}: ${message}`);
    return { error: message };
  }
}

export async function collectDiagnosticsInput(
  sources: DiagnosticsSources,
): Promise<DiagnosticsInput> {
  const collectErrors: string[] = [];

  const logs: DiagnosticsInput['logs'] = [];
  const logFiles = await settle('logs', collectErrors, () =>
    sources.listLogFiles(),
  );
  if (Array.isArray(logFiles)) {
    for (const file of logFiles.slice(0, LOG_RETENTION_DAYS)) {
      try {
        const read = await sources.readLog(file.date, MAX_LOG_BYTES_PER_DAY);
        if (read) logs.push({ date: file.date, ...read });
      } catch (error) {
        collectErrors.push(`logs ${file.date}: ${errorMessage(error)}`);
      }
    }
  }

  const events = await settle('crashEvents', collectErrors, () =>
    sources.readCrashEvents(),
  );
  const crashEvents =
    'error' in events ? { current: null, rotated: null } : events;

  const dumps: DiagnosticsDump[] = [];
  const dumpList = await settle('dumps', collectErrors, () =>
    sources.listDumps(),
  );
  if (Array.isArray(dumpList)) {
    for (const dump of dumpList) {
      let summary: MinidumpSummary | null = null;
      try {
        summary = sources.summarizeDump(dump.file);
      } catch (error) {
        collectErrors.push(
          `dump ${path.basename(dump.file)}: ${errorMessage(error)}`,
        );
      }
      dumps.push({
        name: path.basename(dump.file),
        file: dump.file,
        size: dump.size,
        mtimeMs: dump.mtimeMs,
        summary,
      });
    }
  }

  const system = await settle('system', collectErrors, () => sources.system());
  const gpu = await settle('gpu', collectErrors, () => sources.gpu());
  const settings = await settle('settings', collectErrors, () => {
    const { settings: s, userConfig } = sources.settings();
    return buildSettingsSnapshot(s, userConfig);
  });
  const addon = await settle('addon', collectErrors, () => sources.addon());

  return {
    now: sources.now,
    appVersion: sources.appVersion,
    logs,
    crashEvents,
    dumps,
    system,
    gpu,
    settings,
    addon,
    collectErrors,
  };
}

/** 导出前给用户看的内容清单；任何一项读不到就按“没有”处理。 */
export async function previewDiagnostics(
  sources: DiagnosticsSources,
): Promise<DiagnosticsPreview> {
  let logDays = 0;
  let logBytes = 0;
  try {
    const files = (await sources.listLogFiles()).slice(0, LOG_RETENTION_DAYS);
    logDays = files.length;
    logBytes = files.reduce(
      (sum, f) => sum + Math.min(f.size, MAX_LOG_BYTES_PER_DAY),
      0,
    );
  } catch {
    // 读不到按没有处理
  }

  let crashEventCount = 0;
  try {
    const events = await sources.readCrashEvents();
    for (const text of [events.current, events.rotated]) {
      if (text)
        crashEventCount += text.split('\n').filter((l) => l.trim()).length;
    }
  } catch {
    // 同上
  }

  const dumps: DiagnosticsDumpPreview[] = [];
  let dumpBytes = 0;
  try {
    for (const dump of sources.listDumps()) {
      let summary: MinidumpSummary | null = null;
      try {
        summary = sources.summarizeDump(dump.file);
      } catch {
        summary = null;
      }
      dumps.push({
        name: path.basename(dump.file),
        size: dump.size,
        mtimeMs: dump.mtimeMs,
        exception: summary?.exception?.name ?? null,
        faultModule: summary?.faultModule?.name ?? null,
      });
      dumpBytes += dump.size;
    }
  } catch {
    // 同上
  }

  return {
    logDays,
    logBytes,
    crashEventCount,
    dumps,
    dumpBytes,
    crashReporterEnabled: sources.crashReporterEnabled,
    suggestedFileName: diagnosticsFileName(sources.now),
  };
}

// ---------------------------------------------------------------------------
// 拼装
// ---------------------------------------------------------------------------

const README = `SmartSub 诊断包 / SmartSub diagnostics bundle

这是 SmartSub 在你的电脑上生成的排查资料，只保存在你选择的位置，不会自动上传。
This bundle was generated locally by SmartSub. Nothing is uploaded automatically.

内容 / Contents
- logs/            最近 7 天应用日志（API Key 已脱敏，用户目录已替换为 ~）
                   Application logs of the last 7 days (API keys masked, home directory replaced by ~)
- crash/           崩溃事件、转储摘要（异常码、故障模块、CPU 型号）；勾选时才含原始转储
                   Crash events and minidump summaries; raw dumps only if you opted in
- system.json      系统、CPU（含指令集标志）、内存 / OS, CPU (with instruction-set flags), memory
- gpu.json         显卡与加速环境 / GPU and acceleration environment
- settings.json    部分设置（白名单；不含 API Key、服务商配置，路径只说明是否自定义）
                   A whitelisted subset of settings (no API keys or provider configs; paths are not included)
- addon.json       whisper 加速包的加载记录与崩溃熔断状态 / whisper addon load history and crash-breaker state

隐私 / Privacy
- 不含 API Key、翻译 / 配音 / 听写服务商配置，也不含媒体与字幕文件。
  No API keys, provider configurations, media or subtitle files.
- 日志里可能仍有文件名等信息，发给他人前可自行打开检查。
  Logs may still mention file names; feel free to review them before sharing.
- 原始转储（crash/dumps/*.dmp，仅勾选时存在）可能含崩溃时的内存片段。
  Raw dumps (crash/dumps/*.dmp, only if selected) may contain fragments of memory at crash time.
`;

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 文件名只留安全字符，避免 zip 里出现路径穿越或奇怪字符。 */
function safeEntryName(name: string): string {
  return path.basename(name).replace(/[^\w.\-]/g, '_') || 'dump.dmp';
}

export function buildBundleEntries(
  input: DiagnosticsInput,
  options: BundleOptions,
): BuildResult {
  const root = diagnosticsRootName(input.now);
  const mtime = new Date(input.now);
  const entries: BundleEntry[] = [];
  const sizes: Array<{ name: string; bytes: number }> = [];
  const clean = (s: string) => options.redact(options.sanitize(s));
  const redactOnly = (s: string) => options.redact(s);

  const addText = (name: string, content: string) => {
    entries.push({ name: `${root}/${name}`, content, mtime });
    sizes.push({ name, bytes: Buffer.byteLength(content, 'utf8') });
  };
  const addJson = (name: string, value: unknown) =>
    addText(name, toJson(mapStringsDeep(value, redactOnly)));

  addText('README.txt', README);

  const logDays: string[] = [];
  const logsTruncated: string[] = [];
  for (const log of input.logs) {
    addText(`logs/${log.date}.jsonl`, sanitizeLogJsonl(log.text, options));
    logDays.push(log.date);
    if (log.truncated) logsTruncated.push(log.date);
  }

  let crashEventLines = 0;
  const eventFiles: Array<[string, string | null]> = [
    ['crash/crash-events.jsonl', input.crashEvents.current],
    ['crash/crash-events.1.jsonl', input.crashEvents.rotated],
  ];
  for (const [name, text] of eventFiles) {
    if (!text) continue;
    const sanitized = sanitizeEventsJsonl(text, options);
    if (!sanitized.lines) continue;
    addText(name, sanitized.text);
    crashEventLines += sanitized.lines;
  }

  addJson(
    'crash/dump-summaries.json',
    input.dumps.map((dump) => ({
      name: dump.name,
      bytes: dump.size,
      modified: new Date(dump.mtimeMs).toISOString(),
      summary: dump.summary,
    })),
  );

  const rawDumps: string[] = [];
  if (options.includeRawDumps) {
    for (const dump of input.dumps) {
      const name = `crash/dumps/${safeEntryName(dump.name)}`;
      entries.push({
        name: `${root}/${name}`,
        filePath: dump.file,
        mtime: new Date(dump.mtimeMs),
      });
      sizes.push({ name, bytes: dump.size });
      rawDumps.push(name);
    }
  }

  addJson('system.json', input.system);
  addJson('gpu.json', input.gpu);
  addJson('settings.json', input.settings);
  addJson('addon.json', input.addon);

  const manifest: BundleManifest = {
    format: 1,
    generatedAt: new Date(input.now).toISOString(),
    appVersion: input.appVersion,
    logDays,
    logsTruncated,
    crashEventLines,
    dumpSummaries: input.dumps.length,
    rawDumps,
    collectErrors: input.collectErrors.map(clean),
    files: sizes,
  };
  entries.push({
    name: `${root}/manifest.json`,
    content: toJson(manifest),
    mtime,
  });

  return { root, entries, manifest };
}

// ---------------------------------------------------------------------------
// GitHub issue 预填
// ---------------------------------------------------------------------------

export const ISSUE_URL_BASE = 'https://github.com/buxuku/SmartSub/issues/new';

export interface IssueSummary {
  appVersion: string;
  /** 例如 "win32 10.0.19045 (x64)" */
  os: string;
  cpuModel: string | null;
  gpuNames: string[];
  /** 最近一次崩溃的一行描述，如 "illegal-instruction (0xC000001D)"；没有为 null */
  latestCrash: string | null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 预填的新建 issue 地址：只带环境摘要，不带日志内容。
 * 日志以 zip 附件的形式由用户自己拖进 issue。
 */
export function buildIssueUrl(
  summary: IssueSummary,
  language: 'zh' | 'en',
): string {
  const zh = language === 'zh';
  const lines = [
    zh ? '**环境**' : '**Environment**',
    `- SmartSub: ${clip(summary.appVersion, 32)}`,
    `- OS: ${clip(summary.os, 80)}`,
    `- CPU: ${clip(summary.cpuModel ?? 'unknown', 120)}`,
    ...(summary.gpuNames.length
      ? [`- GPU: ${clip(summary.gpuNames.slice(0, 4).join(', '), 200)}`]
      : []),
    ...(summary.latestCrash
      ? [
          `- ${zh ? '最近一次崩溃' : 'Latest crash'}: ${clip(summary.latestCrash, 120)}`,
        ]
      : []),
    '',
    zh ? '**发生了什么**' : '**What happened**',
    zh
      ? '（请描述操作步骤和现象，并把导出的诊断包 zip 拖进来上传）'
      : '(Describe the steps and what you saw, then drag the exported diagnostics zip here)',
    '',
  ];
  const url = new URL(ISSUE_URL_BASE);
  url.searchParams.set('title', zh ? '闪退反馈' : 'Crash report');
  url.searchParams.set('body', lines.join('\n'));
  return url.toString();
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

/**
 * 写 zip：先写临时文件再改名，失败不留下半个文件。
 * yazl 的读文件错误（如转储在导出前被清理掉）只通过 'error' 事件报告，必须监听，
 * 否则会变成未捕获异常。
 */
export async function writeZipFile(
  target: string,
  entries: BundleEntry[],
): Promise<number> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  const zip = new ZipFile();
  for (const entry of entries) {
    if ('filePath' in entry) {
      zip.addFile(entry.filePath, entry.name, { mtime: entry.mtime });
    } else {
      zip.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name, {
        mtime: entry.mtime,
      });
    }
  }
  const out = fs.createWriteStream(temp);
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.outputStream.on('error', reject);
      out.on('error', reject);
      out.on('close', resolve);
      zip.outputStream.pipe(out);
      zip.end();
    });
    await fs.promises.rename(temp, target);
  } catch (error) {
    out.destroy();
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return (await fs.promises.stat(target)).size;
}
