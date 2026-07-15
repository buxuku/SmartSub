/**
 * 统一合成引擎 · 作业队列。
 *
 * FIFO 单执行槽（重编码作业互斥；软封/流复制类作业秒级，排队无感）。
 * 作业状态机：queued → running → done | error | cancelled；排队中取消直接出队。
 * 进度事件统一经 setComposeEventListeners 注入的回调发出（携带 jobId/source，
 * 渲染层按来源过滤各自面板的进度）；队列变动广播快照供排队位置展示。
 */

import { randomUUID } from 'crypto';
import { logMessage } from '../storeManager';
import {
  acquireTaskPowerSaveBlocker,
  releaseTaskPowerSaveBlocker,
} from '../powerSaveManager';
import { MERGE_CANCELLED } from '../subtitleMerger';
import { runComposeJob } from './composeRunner';
import type {
  ComposeConfig,
  ComposeJobSource,
  ComposeJobStatus,
  ComposeJobView,
  MergeProgress,
} from '../../../types/subtitleMerge';

const COMPOSE_POWER_SAVE_REASON = 'compose';
/** 终态作业在快照中保留的条数（防内存泄漏；UI 只关心近况） */
const FINISHED_JOBS_KEEP = 20;

export interface ComposeJobResult {
  success: boolean;
  outputPath?: string;
  cancelled?: boolean;
  error?: string;
}

interface InternalJob {
  id: string;
  config: ComposeConfig;
  source: ComposeJobSource;
  status: ComposeJobStatus;
  createdAt: number;
  error?: string;
  /** runner 注册的"杀当前 ffmpeg"入口（running 时有效） */
  cancelRunning?: () => void;
  /** 可选的作业级进度回调（流水线阶段等提交方直连消费） */
  onProgress?: (progress: MergeProgress) => void;
  settle: (result: ComposeJobResult) => void;
  done: Promise<ComposeJobResult>;
}

let jobs: InternalJob[] = [];
let runningJob: InternalJob | null = null;
let pumping = false;

let progressListener: ((progress: MergeProgress) => void) | null = null;
let queueListener: ((snapshot: ComposeJobView[]) => void) | null = null;

/** 注入事件出口（IPC 层 setup 时调用，转发给渲染层） */
export function setComposeEventListeners(listeners: {
  onProgress: (progress: MergeProgress) => void;
  onQueueChange: (snapshot: ComposeJobView[]) => void;
}): void {
  progressListener = listeners.onProgress;
  queueListener = listeners.onQueueChange;
}

function toView(job: InternalJob): ComposeJobView {
  const { subtitle, audio } = job.config;
  return {
    id: job.id,
    status: job.status,
    source: job.source,
    outputPath: job.config.outputPath,
    createdAt: job.createdAt,
    error: job.error,
    videoPath: job.config.videoPath,
    subtitlePath: subtitle.mode === 'none' ? undefined : subtitle.subtitlePath,
    subtitleMode: subtitle.mode,
    audioTrack:
      audio.mode === 'keep'
        ? undefined
        : { mode: audio.mode, trackPath: audio.trackPath },
  };
}

export function getComposeQueueSnapshot(): ComposeJobView[] {
  return jobs.map(toView);
}

function pruneFinished(): void {
  const finished = jobs.filter(
    (job) => job.status !== 'queued' && job.status !== 'running',
  );
  if (finished.length <= FINISHED_JOBS_KEEP) return;
  const dropIds = new Set(
    finished
      .slice(0, finished.length - FINISHED_JOBS_KEEP)
      .map((job) => job.id),
  );
  jobs = jobs.filter((job) => !dropIds.has(job.id));
}

function broadcastQueue(): void {
  pruneFinished();
  queueListener?.(getComposeQueueSnapshot());
  // 排队中的作业同步更新"前方还有 N 个"（渲染层以 processing 态展示等待）
  const queued = jobs.filter((job) => job.status === 'queued');
  queued.forEach((job, index) => {
    progressListener?.({
      percent: 0,
      timeMark: '',
      targetSize: 0,
      status: 'processing',
      jobId: job.id,
      source: job.source,
      queuedAhead: index + (runningJob ? 1 : 0),
    });
  });
}

/** 入列一个合成作业：返回 jobId（即时）与完成 promise（终态时 resolve） */
export function enqueueCompose(
  config: ComposeConfig,
  source: ComposeJobSource,
  opts?: { onProgress?: (progress: MergeProgress) => void },
): { jobId: string; done: Promise<ComposeJobResult> } {
  let settle!: (result: ComposeJobResult) => void;
  const done = new Promise<ComposeJobResult>((resolve) => {
    settle = resolve;
  });
  const job: InternalJob = {
    id: randomUUID(),
    config,
    source,
    status: 'queued',
    createdAt: Date.now(),
    onProgress: opts?.onProgress,
    settle,
    done,
  };
  jobs.push(job);
  logMessage(
    `合成作业入列: ${job.id} (source=${source}, output=${config.outputPath})`,
    'info',
  );
  broadcastQueue();
  void pump();
  return { jobId: job.id, done };
}

/**
 * 取消作业：
 * - 指定 jobId：取消该作业（排队直接出队；运行中 kill ffmpeg）。
 * - 未指定：取消给定来源（缺省 subtitleMerge）的活动作业——合成面板一次只有
 *   一个活动作业，维持既有"无参取消"IPC 契约。
 */
export function cancelComposeJob(
  jobId?: string,
  source: ComposeJobSource = 'subtitleMerge',
): boolean {
  const target = jobId
    ? jobs.find((job) => job.id === jobId)
    : [...jobs]
        .reverse()
        .find(
          (job) =>
            job.source === source &&
            (job.status === 'queued' || job.status === 'running'),
        );
  if (!target) return false;

  if (target.status === 'queued') {
    target.status = 'cancelled';
    logMessage(`合成作业已从队列移除: ${target.id}`, 'warning');
    target.settle({ success: true, cancelled: true });
    // 排队取消也要给该作业发 idle 进度：渲染层等待 done 的同时靠它复位展示
    progressListener?.({
      percent: 0,
      timeMark: '',
      targetSize: 0,
      status: 'idle',
      jobId: target.id,
      source: target.source,
    });
    broadcastQueue();
    return true;
  }
  if (target.status === 'running') {
    target.cancelRunning?.();
    return true;
  }
  return false;
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = jobs.find((job) => job.status === 'queued');
      if (!next) break;
      runningJob = next;
      next.status = 'running';
      broadcastQueue();
      acquireTaskPowerSaveBlocker(COMPOSE_POWER_SAVE_REASON);
      try {
        const outputPath = await runComposeJob(next.config, {
          jobId: next.id,
          onProgress: (progress) => {
            const withSource = { ...progress, source: next.source };
            progressListener?.(withSource);
            next.onProgress?.(withSource);
          },
          setCancel: (cancel) => {
            next.cancelRunning = cancel;
          },
        });
        next.status = 'done';
        next.settle({ success: true, outputPath });
      } catch (err) {
        const error = err as Error;
        if (error.message === MERGE_CANCELLED) {
          next.status = 'cancelled';
          next.settle({ success: true, cancelled: true });
        } else {
          next.status = 'error';
          next.error = error.message;
          next.settle({ success: false, error: error.message });
        }
      } finally {
        next.cancelRunning = undefined;
        runningJob = null;
        releaseTaskPowerSaveBlocker(COMPOSE_POWER_SAVE_REASON);
        broadcastQueue();
      }
    }
  } finally {
    pumping = false;
  }
}

/** 是否有合成作业在执行或排队（关窗提示等场景复用） */
export function isComposeBusy(): boolean {
  return jobs.some(
    (job) => job.status === 'queued' || job.status === 'running',
  );
}
