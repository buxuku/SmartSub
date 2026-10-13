/**
 * sherpa 原生库的"静默失败"：把它变成用户看得懂、日志里查得到的错误。
 *
 * - VAD 构造函数配置校验失败时**不抛错**：只往 stderr 写一两行原因，返回空句柄；之后每次使用都
 *   打印一行 `vad is nullptr` 并什么都不做，最终得到零个语音段（真实 Windows 现场一个文件 600+ 行）。
 * - 识别器 / 降噪 / TTS / 说话人分离的构造函数会抛，但消息只有 `Please check your config!`，
 *   真正的原因同样只在 stderr。
 *
 * 路径含非 ASCII 字符的 Windows 用户（用户名是中文时默认目录就是）最常撞上这个问题，
 * 所以失败时若涉及这类路径，附上处理建议。本文件是纯逻辑，运行时接线在 sherpaFunasrRuntime.ts。
 */
import { needsNativeSafe } from './nativeSafePath';

export type FailureLanguage = 'zh' | 'en';

export interface FailureHintOptions {
  language: FailureLanguage;
  /** 缺省取 process.platform；仅 win32 会追加路径建议 */
  platform?: NodeJS.Platform;
}

const VAD_NULL_LINE = /vad is nullptr/i;
/** 能解释"为什么失败"的行：sherpa 的 Validate 校验、`Errors in config`、打不开文件 */
const REASON_LINE =
  /does not exist|errors? in config|failed|invalid|unable|cannot|not found/i;
/** 概括性的一行，已经有更具体的原因时丢弃 */
const GENERIC_REASON = /^errors? in config$/i;
/** 原生库日志的 `<源码路径>.cc:函数:行号 ` 前缀，对用户没有意义 */
const SOURCE_LOCATION = /^.*?\.(?:cc|cpp|h|hpp):\w+:\d+\s+/;
/** 原生库因"打不开文件 / 配置无效"而失败的消息特征（取消、忙碌等其他错误不追加建议） */
const NATIVE_OPEN_FAILURE =
  /check your config|does not exist|failed to (?:read|open|create|load)|nullptr|errors? in config/i;

/**
 * 零结果完成后等多久再判断是不是 VAD 静默失败。worker 的 stderr（管道）与结果消息（IPC）是两条
 * 独立通道，到达先后没有保证；零结果本来就少见，这点延迟可以忽略。
 */
export const NATIVE_STDERR_DRAIN_MS = 200;

const MAX_RECENT_LINES = 20;
const MAX_REASONS = 2;
const MAX_COLLECT_DEPTH = 6;

const PATH_HINTS: Record<FailureLanguage, string> = {
  zh: '检测到路径含非 ASCII 字符（如中文），Windows 上的原生库可能无法打开：请在「设置」的「统一存储目录」中选择纯英文路径（如 D:\\SmartSub）并重新下载或导入模型；若应用本身安装在含中文的目录，请重装到纯英文目录。',
  en: 'A path contains non-ASCII characters (for example Chinese), which native libraries may fail to open on Windows. Set a path with ASCII characters only under Settings → Unified Storage Directory (for example D:\\SmartSub) and download or import the models again; if the app itself is installed in a folder with such characters, reinstall it into an ASCII-only folder.',
};

function stripSourceLocation(line: string): string {
  return line.replace(SOURCE_LOCATION, '').trim();
}

function pickReasons(recent: readonly string[]): string[] {
  const candidates = recent
    .filter((line) => REASON_LINE.test(line))
    .map(stripSourceLocation)
    .filter((line) => line.length > 0);
  const specific = candidates.filter((line) => !GENERIC_REASON.test(line));
  return (specific.length > 0 ? specific : candidates).slice(-MAX_REASONS);
}

/**
 * 逐行观察原生库的 stderr：统计 `vad is nullptr`，并在**第一次**出现时把此前的原因行存下来
 * （之后那几百行重复只计数，不保存）。每个 worker 进程一个实例，worker 重建时 reset。
 */
export class NativeStderrWatch {
  private recent: string[] = [];
  private count = 0;
  private reasons: string[] = [];

  push(line: string): void {
    const text = line.trim();
    if (!text) return;
    if (VAD_NULL_LINE.test(text)) {
      if (this.count === 0) this.reasons = pickReasons(this.recent);
      this.count += 1;
      return;
    }
    this.recent.push(text);
    if (this.recent.length > MAX_RECENT_LINES) this.recent.shift();
  }

  /** 自上次 reset 起累计看到多少行 `vad is nullptr` */
  get nullVadCount(): number {
    return this.count;
  }

  /** 第一次 `vad is nullptr` 之前原生库给出的原因（可能为空） */
  get nullVadReasons(): readonly string[] {
    return this.reasons;
  }

  reset(): void {
    this.recent = [];
    this.count = 0;
    this.reasons = [];
  }
}

function appendPathHint(
  message: string,
  paths: readonly string[],
  options: FailureHintOptions,
): string {
  const platform = options.platform ?? process.platform;
  if (!paths.some((p) => needsNativeSafe(p, platform))) return message;
  if (message.includes(PATH_HINTS.zh) || message.includes(PATH_HINTS.en)) {
    return message;
  }
  return `${message} ${PATH_HINTS[options.language]}`;
}

/** VAD 静默失败（零语音段 + `vad is nullptr`）对应的错误文案。 */
export function describeNullVad(
  input: FailureHintOptions & {
    reasons: readonly string[];
    /** 交给原生库的模型路径（已暂存的写暂存后的路径）：含非 ASCII 才追加建议 */
    paths: readonly string[];
  },
): string {
  const reason = input.reasons.join('; ');
  const head =
    input.language === 'zh'
      ? `本地语音活动检测（VAD）模型加载失败，无法检测语音${reason ? `：${reason}` : '。'}`
      : `The local voice activity detection (VAD) model failed to load, so no speech could be detected${reason ? `: ${reason}` : '.'}`;
  return appendPathHint(head, input.paths, input);
}

/**
 * 给"原生库打不开文件"类错误（如 `Please check your config!`）追加路径建议；
 * 只在 Windows 且确有非 ASCII 路径时追加，其他错误（取消、忙碌…）原样返回。
 */
export function withNonAsciiPathHint(
  message: string,
  paths: readonly string[],
  options: FailureHintOptions,
): string {
  if (!NATIVE_OPEN_FAILURE.test(message)) return message;
  return appendPathHint(message, paths, options);
}

/** 递归收集请求对象里的所有字符串（模型 / tokens / 目录路径），用于判断是否涉及非 ASCII 路径。 */
export function collectNativePaths(...values: unknown[]): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (
      depth >= MAX_COLLECT_DEPTH ||
      value === null ||
      typeof value !== 'object'
    ) {
      return;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) visit(child, depth + 1);
  };
  for (const value of values) visit(value, 0);
  return out;
}
