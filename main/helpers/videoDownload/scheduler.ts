import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import { logMessage, store } from '../storeManager';
import { getWorkItemById, saveWorkItem } from '../workItemStore';
import {
  getDownloaderBinaryPath,
  getInstalledEngines,
} from '../downloaderManager';
import { routeEngines } from '../../../types/download';
import type {
  DownloadConfigSnapshot,
  DownloadEngineChoice,
  DownloadEntry,
  DownloadEntryMeta,
  DownloadQuality,
  DownloaderEngine,
} from '../../../types/download';
import type { WorkItem, WorkItemStatus } from '../../../types/workItem';
import { isLikelyOutdatedEngineError } from './parsers';
import { isCancelledError } from './engineAdapter';
import { ytDlpAdapter } from './ytDlpAdapter';
import { luxAdapter } from './luxAdapter';
import type { DownloadEngineAdapter } from './engineAdapter';

const ADAPTERS: Record<DownloaderEngine, DownloadEngineAdapter> = {
  'yt-dlp': ytDlpAdapter,
  lux: luxAdapter,
};

const CANCELLED_ERROR = 'CANCELLED';
/** 进度事件节流：每条目 ≤2 次/秒 */
const PROGRESS_EMIT_INTERVAL_MS = 500;

export interface DownloadEntryEvent {
  workItemId: string;
  entry: DownloadEntry;
}

export interface DownloadSummaryEvent {
  /** 有下载批次在执行 */
  running: boolean;
  /** 执行中条目数 */
  activeCount: number;
  /** 运行中批次的整体进度 0-100 */
  progress: number;
}

type Emitter = (channel: string, ...args: unknown[]) => void;

let emit: Emitter = () => {};

export function setVideoDownloadEmitter(emitter: Emitter): void {
  emit = emitter;
}

interface QueuedJob {
  workItemId: string;
  entryId: string;
}

interface BatchRuntime {
  cancelled: boolean;
  controllers: Map<string, AbortController>;
}

let queue: QueuedJob[] = [];
const runtimes = new Map<string, BatchRuntime>();
let activeCount = 0;
const lastEmitAt = new Map<string, number>();

function getConcurrency(): number {
  try {
    const value = (
      store.get('settings') as { videoDownloadConcurrency?: number }
    )?.videoDownloadConcurrency;
    const n = Number(value);
    if (Number.isFinite(n)) return Math.min(Math.max(Math.round(n), 1), 5);
  } catch {
    // fallthrough
  }
  return 2;
}

function ensureRuntime(workItemId: string): BatchRuntime {
  let runtime = runtimes.get(workItemId);
  if (!runtime) {
    runtime = { cancelled: false, controllers: new Map() };
    runtimes.set(workItemId, runtime);
  }
  return runtime;
}

/** 下载批次是否有执行/排队中的条目（外部忙判定：如更新引擎前检查） */
export function isVideoDownloadBusy(): boolean {
  return activeCount > 0 || queue.length > 0;
}

function deriveStatus(entries: DownloadEntry[]): WorkItemStatus {
  if (entries.some((e) => e.status === 'loading')) return 'running';
  if (entries.some((e) => e.status === '')) return 'waiting';
  return entries.some((e) => e.status === 'error') ? 'error' : 'done';
}

/** 以最新 store 状态为基线更新条目并派生任务状态（返回更新后的条目） */
function updateEntry(
  workItemId: string,
  entryId: string,
  patch: Partial<DownloadEntry>,
  opts: { deriveItemStatus?: boolean; forceEmit?: boolean } = {},
): DownloadEntry | null {
  const item = getWorkItemById(workItemId);
  if (!item || item.type !== 'download') return null;
  const entries = (item.downloadEntries || []).map((entry) =>
    entry.id === entryId ? { ...entry, ...patch } : entry,
  );
  const updated = entries.find((e) => e.id === entryId) || null;
  const next: WorkItem = {
    ...item,
    downloadEntries: entries,
    updatedAt: Date.now(),
  };
  if (opts.deriveItemStatus) {
    next.status = deriveStatus(entries);
    if (next.status === 'done' || next.status === 'error') {
      next.finishedAt = Date.now();
    }
  }
  saveWorkItem(next);

  if (updated) {
    const now = Date.now();
    const last = lastEmitAt.get(entryId) || 0;
    if (opts.forceEmit || now - last >= PROGRESS_EMIT_INTERVAL_MS) {
      lastEmitAt.set(entryId, now);
      emit('videoDownload:entryChanged', {
        workItemId,
        entry: updated,
      } satisfies DownloadEntryEvent);
    }
  }
  emitSummary();
  return updated;
}

function emitItemChanged(workItemId: string): void {
  emit('videoDownload:itemChanged', { workItemId });
  emitSummary();
}

let lastSummaryKey = '';

function emitSummary(): void {
  let total = 0;
  let sum = 0;
  let loading = 0;
  runtimes.forEach((_runtime, id) => {
    const item = getWorkItemById(id);
    if (!item || item.type !== 'download') return;
    if (item.status !== 'running' && item.status !== 'waiting') return;
    for (const entry of item.downloadEntries || []) {
      total += 1;
      if (entry.status === 'done') sum += 100;
      else sum += entry.progress || 0;
      if (entry.status === 'loading') loading += 1;
    }
  });
  const summary: DownloadSummaryEvent = {
    running: loading > 0 || queue.length > 0,
    activeCount: loading,
    progress: total > 0 ? Math.round(sum / total) : 0,
  };
  // 摘要仅在内容变化时广播（状态栏 pill 消费，避免风暴）
  const key = `${summary.running}|${summary.activeCount}|${summary.progress}`;
  if (key === lastSummaryKey) return;
  lastSummaryKey = key;
  emit('videoDownload:summary', summary);
}

export interface StartDownloadPayload {
  name: string;
  savePath: string;
  quality: DownloadQuality;
  engine: DownloadEngineChoice;
  entries: Array<{
    url: string;
    meta?: DownloadEntryMeta;
    expandPlaylist?: boolean;
  }>;
}

/**
 * 创建 download WorkItem 并入列。播放列表条目在此展开：
 * 预检拿到 playlistItems 且用户确认展开 → 逐条建 entry；
 * 未预检的播放列表 → 单 entry 交给引擎 --yes-playlist 兜底。
 */
export function startDownloadBatch(payload: StartDownloadPayload): WorkItem {
  if (!payload.savePath) throw new Error('savePath is required');
  fs.mkdirSync(payload.savePath, { recursive: true });

  const installed = getInstalledEngines();
  if (installed.length === 0) {
    throw new Error('No downloader engine installed');
  }

  const entries: DownloadEntry[] = [];
  for (const input of payload.entries) {
    const routed = routeEngines(input.url, payload.engine, installed);
    const engine = routed[0] || installed[0];
    if (input.expandPlaylist && input.meta?.playlistItems?.length) {
      for (const item of input.meta.playlistItems) {
        entries.push({
          id: uuidv4(),
          url: item.url,
          engine,
          status: '',
          meta: item.title ? { title: item.title } : undefined,
        });
      }
    } else {
      entries.push({
        id: uuidv4(),
        url: input.url,
        engine,
        status: '',
        meta: input.meta,
        expandPlaylist: input.expandPlaylist,
      });
    }
  }
  if (entries.length === 0) throw new Error('No entries to download');

  const snapshot: DownloadConfigSnapshot = {
    savePath: payload.savePath,
    quality: payload.quality,
    engine: payload.engine,
  };
  const now = Date.now();
  const item: WorkItem = {
    id: uuidv4(),
    name: payload.name,
    type: 'download',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    downloadEntries: entries,
    configSnapshot: snapshot as unknown as Record<string, unknown>,
    artifacts: [],
  };
  saveWorkItem(item);
  ensureRuntime(item.id).cancelled = false;

  queue.push(...entries.map((e) => ({ workItemId: item.id, entryId: e.id })));
  emitItemChanged(item.id);
  pump();
  return item;
}

/** 中断批次「继续下载」：未完成（''）条目重新入列，断点由引擎续传 */
export function resumeDownloadBatch(workItemId: string): boolean {
  const item = getWorkItemById(workItemId);
  if (!item || item.type !== 'download') return false;
  const pending = (item.downloadEntries || []).filter((e) => e.status === '');
  if (pending.length === 0) return false;

  const runtime = ensureRuntime(workItemId);
  runtime.cancelled = false;
  saveWorkItem({ ...item, status: 'running', updatedAt: Date.now() });
  const queued = new Set(
    queue.filter((j) => j.workItemId === workItemId).map((j) => j.entryId),
  );
  queue.push(
    ...pending
      .filter((e) => !queued.has(e.id))
      .map((e) => ({ workItemId, entryId: e.id })),
  );
  emitItemChanged(workItemId);
  pump();
  return true;
}

/** 失败条目重试；updateEngineFirst 由 IPC 层在重试前完成（本函数只重新入列） */
export function retryDownloadEntry(
  workItemId: string,
  entryId: string,
): boolean {
  const item = getWorkItemById(workItemId);
  if (!item || item.type !== 'download') return false;
  const entry = (item.downloadEntries || []).find((e) => e.id === entryId);
  if (!entry || entry.status === 'loading' || entry.status === 'done') {
    return false;
  }
  ensureRuntime(workItemId).cancelled = false;
  updateEntry(
    workItemId,
    entryId,
    {
      status: '',
      error: undefined,
      progress: 0,
      speed: undefined,
      eta: undefined,
    },
    { deriveItemStatus: true, forceEmit: true },
  );
  const alreadyQueued = queue.some(
    (j) => j.workItemId === workItemId && j.entryId === entryId,
  );
  if (!alreadyQueued) queue.push({ workItemId, entryId });
  const refreshed = getWorkItemById(workItemId);
  if (refreshed && refreshed.status !== 'running') {
    saveWorkItem({ ...refreshed, status: 'running', updatedAt: Date.now() });
  }
  emitItemChanged(workItemId);
  pump();
  return true;
}

/** 单条取消：排队中移除，执行中 abort；条目落错误态（可重试） */
export function cancelDownloadEntry(
  workItemId: string,
  entryId: string,
): boolean {
  queue = queue.filter(
    (j) => !(j.workItemId === workItemId && j.entryId === entryId),
  );
  const runtime = runtimes.get(workItemId);
  const controller = runtime?.controllers.get(entryId);
  if (controller) {
    controller.abort();
    // 状态推进由 runEntry 的取消分支完成
    return true;
  }
  updateEntry(
    workItemId,
    entryId,
    { status: 'error', error: CANCELLED_ERROR },
    { deriveItemStatus: true, forceEmit: true },
  );
  emitItemChanged(workItemId);
  return true;
}

/** 整批取消：清排队 + abort 执行中；未完成条目回到待下载，任务标记中断 */
export function cancelDownloadBatch(workItemId: string): boolean {
  const item = getWorkItemById(workItemId);
  if (!item || item.type !== 'download') return false;
  queue = queue.filter((j) => j.workItemId !== workItemId);
  const runtime = ensureRuntime(workItemId);
  runtime.cancelled = true;
  runtime.controllers.forEach((controller) => controller.abort());

  const entries = (item.downloadEntries || []).map((entry) =>
    entry.status === '' || entry.status === 'loading'
      ? { ...entry, status: '' as const, speed: undefined, eta: undefined }
      : entry,
  );
  saveWorkItem({
    ...getWorkItemById(workItemId)!,
    downloadEntries: entries,
    status: 'interrupted',
    updatedAt: Date.now(),
  });
  emitItemChanged(workItemId);
  return true;
}

function takeNextJob(): QueuedJob | null {
  while (queue.length > 0) {
    const job = queue.shift()!;
    const runtime = runtimes.get(job.workItemId);
    if (runtime?.cancelled) continue;
    const item = getWorkItemById(job.workItemId);
    if (!item || item.type !== 'download') continue;
    const entry = (item.downloadEntries || []).find(
      (e) => e.id === job.entryId,
    );
    if (!entry || entry.status !== '') continue;
    return job;
  }
  return null;
}

function pump(): void {
  const concurrency = getConcurrency();
  while (activeCount < concurrency) {
    const job = takeNextJob();
    if (!job) break;
    activeCount += 1;
    void runEntry(job).finally(() => {
      activeCount -= 1;
      pump();
    });
  }
  emitSummary();
}

async function runEntry(job: QueuedJob): Promise<void> {
  const { workItemId, entryId } = job;
  const item = getWorkItemById(workItemId);
  if (!item || item.type !== 'download') return;
  const entry = (item.downloadEntries || []).find((e) => e.id === entryId);
  if (!entry) return;
  const snapshot = (item.configSnapshot ||
    {}) as unknown as DownloadConfigSnapshot;

  const installed = getInstalledEngines();
  const engineOrder = routeEngines(
    entry.url,
    snapshot.engine || 'auto',
    installed,
  );
  if (engineOrder.length === 0) {
    updateEntry(
      workItemId,
      entryId,
      { status: 'error', error: 'No downloader engine installed' },
      { deriveItemStatus: true, forceEmit: true },
    );
    return;
  }

  const runtime = ensureRuntime(workItemId);
  const controller = new AbortController();
  runtime.controllers.set(entryId, controller);

  const errors: string[] = [];
  let succeeded = false;
  let entryMeta = entry.meta;

  for (let i = 0; i < engineOrder.length; i++) {
    const engine = engineOrder[i];
    const binaryPath = getDownloaderBinaryPath(engine);
    if (!binaryPath) {
      errors.push(`${engine}: not installed`);
      continue;
    }
    const adapter = ADAPTERS[engine];

    updateEntry(
      workItemId,
      entryId,
      {
        status: 'loading',
        engine,
        progress: 0,
        error: undefined,
      },
      { deriveItemStatus: true, forceEmit: true },
    );

    // 跳过预检的 lux 条目先补拉元数据：标题用于 -O 确定性命名（否则同域名批量
    // 下载会撞名认领错文件）与 UI 展示，totalBytes 供进度降级估算。失败不阻断
    // （lux 会按自身提取的标题命名，产物走目录 diff 认领）。
    if (engine === 'lux' && !entryMeta?.title && !controller.signal.aborted) {
      try {
        const meta = await adapter.preflight(binaryPath, { url: entry.url });
        entryMeta = { ...entryMeta, ...meta };
        updateEntry(
          workItemId,
          entryId,
          { meta: entryMeta },
          { forceEmit: true },
        );
      } catch (error) {
        logMessage(
          `lux meta backfill failed (${entry.url}): ${error}`,
          'warning',
        );
      }
    }

    try {
      const result = await adapter.download(binaryPath, {
        url: entry.url,
        savePath: snapshot.savePath,
        quality: snapshot.quality || 'best',
        expandPlaylist: entry.expandPlaylist,
        meta: entryMeta,
        signal: controller.signal,
        onProgress: (p) => {
          updateEntry(workItemId, entryId, {
            progress: p.progress,
            speed: p.speed,
            eta: p.eta,
          });
        },
      });

      // 产物登记：主路径进 entry，全部路径进 artifacts（播放列表兜底可能多个）
      const latest = getWorkItemById(workItemId);
      if (latest && latest.type === 'download') {
        const artifacts = [...(latest.artifacts || [])];
        for (const outputPath of result.outputPaths) {
          if (!artifacts.some((a) => a.path === outputPath)) {
            artifacts.push({ kind: 'video', path: outputPath });
          }
        }
        saveWorkItem({ ...latest, artifacts, updatedAt: Date.now() });
      }
      updateEntry(
        workItemId,
        entryId,
        {
          status: 'done',
          progress: 100,
          speed: undefined,
          eta: undefined,
          outputPath: result.outputPaths[0],
        },
        { deriveItemStatus: true, forceEmit: true },
      );
      succeeded = true;
      break;
    } catch (error) {
      if (isCancelledError(error) || controller.signal.aborted) {
        // 整批取消：cancelDownloadBatch 已把条目回置''；单条取消：落 CANCELLED
        if (!runtime.cancelled) {
          updateEntry(
            workItemId,
            entryId,
            {
              status: 'error',
              error: CANCELLED_ERROR,
              speed: undefined,
              eta: undefined,
            },
            { deriveItemStatus: true, forceEmit: true },
          );
        }
        runtime.controllers.delete(entryId);
        emitItemChanged(workItemId);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${engine}: ${message}`);
      logMessage(
        `videoDownload entry failed via ${engine} (${entry.url}): ${message}`,
        'warning',
      );
    }
  }

  runtime.controllers.delete(entryId);

  if (!succeeded) {
    const combined = errors.join(' || ') || 'download failed';
    updateEntry(
      workItemId,
      entryId,
      {
        status: 'error',
        error: isLikelyOutdatedEngineError(combined)
          ? `MAYBE_OUTDATED::${combined}`
          : combined,
        speed: undefined,
        eta: undefined,
      },
      { deriveItemStatus: true, forceEmit: true },
    );
  }
  emitItemChanged(workItemId);
}
