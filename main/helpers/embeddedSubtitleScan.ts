/**
 * 开始任务前的内封字幕探测调度（纯逻辑：不依赖 electron / ffmpeg，探测函数由调用方注入）。
 *
 * 目标是「用户感觉不到」：固定大小的工作池并发探测，任意一个文件命中就立即中止其余，
 * 整体有硬性时间预算，到点即放弃。放弃不是错误——调用方把 `unknown` 当作「没有」，
 * 不弹窗也不阻塞开始，行为等同于没有这个功能。
 */
import path from 'path';
import {
  canHaveEmbeddedSubtitle,
  type EmbeddedSubtitleStream,
} from './embeddedSubtitleParser';
import {
  EMBEDDED_SCAN_BUDGET_MS,
  EMBEDDED_SCAN_CONCURRENCY,
  EMBEDDED_SCAN_MAX_PATHS,
  type EmbeddedSubtitleHit,
  type EmbeddedSubtitleScanResult,
} from '../../types/embeddedSubtitle';

/** 探测一个文件的字幕流；被中止时应尽快返回（空数组即可），永不 reject 更好。 */
export type EmbeddedSubtitleProbe = (
  filePath: string,
  signal: AbortSignal,
) => Promise<EmbeddedSubtitleStream[]>;

export interface EmbeddedSubtitleScanOptions {
  probe: EmbeddedSubtitleProbe;
  concurrency?: number;
  budgetMs?: number;
  /** 外部中止（例如调用方不再需要结果）。 */
  signal?: AbortSignal;
}

/** 只接受字符串路径数组：去掉非字符串与空串、去重、限量。其它入参视为没有文件。 */
export function normalizeScanFilePaths(payload: unknown): string[] {
  const raw = (payload as { filePaths?: unknown } | null | undefined)
    ?.filePaths;
  if (!Array.isArray(raw)) return [];
  const paths = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string' && item) paths.add(item);
    if (paths.size >= EMBEDDED_SCAN_MAX_PATHS) break;
  }
  return [...paths];
}

export async function scanForEmbeddedSubtitles(
  filePaths: readonly string[],
  {
    probe,
    concurrency = EMBEDDED_SCAN_CONCURRENCY,
    budgetMs = EMBEDDED_SCAN_BUDGET_MS,
    signal: external,
  }: EmbeddedSubtitleScanOptions,
): Promise<EmbeddedSubtitleScanResult> {
  const started = Date.now();
  // 与流水线一致：只有可能内封字幕的容器才值得 spawn
  const candidates = [...new Set(filePaths)].filter(
    (filePath) =>
      typeof filePath === 'string' &&
      canHaveEmbeddedSubtitle(path.extname(filePath)),
  );

  const controller = new AbortController();
  const { signal } = controller;
  const abortAll = () => controller.abort();
  if (external?.aborted) abortAll();
  else external?.addEventListener('abort', abortAll, { once: true });
  const timer = setTimeout(abortAll, Math.max(0, budgetMs));
  // 即使探测函数不理会 signal 也不会拖过预算：它的结果在中止之后一律作废
  const aborted = new Promise<null>((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', () => resolve(null), { once: true });
  });

  let hit: EmbeddedSubtitleHit | undefined;
  let checked = 0;
  let cursor = 0;

  const worker = async () => {
    while (!signal.aborted) {
      const index = cursor++;
      if (index >= candidates.length) return;
      const filePath = candidates[index];
      const streams = await Promise.race([
        // 同步抛错与 reject 都按「该文件没有结果」处理
        (async () => probe(filePath, signal))().catch(
          () => [] as EmbeddedSubtitleStream[],
        ),
        aborted,
      ]);
      // 中止后返回的空结果不可信（进程被杀），不计入「已检查」
      if (streams === null) return;
      // 只有文本轨可直接提取；位图轨（PGS / DVD）不算
      const tracks = streams
        .filter((stream) => stream.isText)
        .map((stream) => ({ language: stream.language, codec: stream.codec }));
      if (tracks.length > 0) {
        if (!hit) {
          hit = { filePath, tracks };
          checked++;
          abortAll();
        }
        return;
      }
      if (signal.aborted) return;
      checked++;
    }
  };

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, concurrency), candidates.length) },
        worker,
      ),
    );
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abortAll);
  }

  const base = {
    checked,
    candidates: candidates.length,
    elapsedMs: Date.now() - started,
  };
  if (hit) return { status: 'found', hit, ...base };
  return { status: checked >= candidates.length ? 'none' : 'unknown', ...base };
}
