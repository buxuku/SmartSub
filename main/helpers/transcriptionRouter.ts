import { getEngineAdapterForTask } from './engines/registry';
import { acquireTranscribeSlot } from './engines/transcribeGate';
import {
  getTaskContext,
  throwIfSignalCancelled,
  isWhisperAbortError,
} from './taskContext';
import { logMessage } from './storeManager';
import type { TranscribeContext } from './engines/types';
import type { TranscriptionEngine } from '../../types/engine';
import type { TranscriptionDiagnostics } from './missedSpeechWarning';
import { runMissedSpeechCheck } from './missedSpeechStage';

async function transcribe(ctx: TranscribeContext): Promise<string> {
  // 引擎按任务携带的 transcriptionEngine 解析（缺省回退 builtin）。
  const adapter = getEngineAdapterForTask(
    ctx.formData as { transcriptionEngine?: TranscriptionEngine },
  );
  const status = await adapter.isAvailable();
  if (status.state !== 'ready') {
    throw new Error(
      `${adapter.displayName} is not available: ${status.message || status.state}`,
    );
  }
  // 取消信号统一在此从任务上下文注入，引擎以 ctx.signal 为准。
  const signal = ctx.signal ?? getTaskContext()?.signal;
  // 阶段流水线：受限引擎（共享单 sidecar/worker）仅转写阶段按组排队，
  // 任务级并发照常——排队期间其它文件的提取/翻译不受影响。等待可被取消。
  const waitStart = Date.now();
  ctx.onActivity?.({ phase: 'queued' });
  const release = await acquireTranscribeSlot(adapter.id, signal);
  const waitedMs = Date.now() - waitStart;
  if (waitedMs > 1000) {
    logMessage(
      `transcribe slot acquired for ${ctx.file.fileName} after ${Math.round(waitedMs / 1000)}s queue (engine=${adapter.id})`,
      'info',
    );
  }
  ctx.onActivity?.({ phase: 'preparing' });
  let diagnostics: TranscriptionDiagnostics = {};
  const mergeDiagnostics = (value: TranscriptionDiagnostics) => {
    diagnostics = {
      vadAvailable: value.vadAvailable ?? diagnostics.vadAvailable,
      vadSegments: value.vadSegments ?? diagnostics.vadSegments,
      wordSegments: value.wordSegments ?? diagnostics.wordSegments,
      reviewSpeechSegments:
        value.reviewSpeechSegments ?? diagnostics.reviewSpeechSegments,
      reviewCompleted: value.reviewCompleted ?? diagnostics.reviewCompleted,
      reviewPending: value.reviewPending ?? diagnostics.reviewPending,
    };
  };
  let output: string;
  ctx.file.missedSpeechWarnings = [];
  ctx.file.missedSpeechSummary = undefined;
  ctx.file.wordTimelineFile = undefined;
  ctx.file.speechReviewStage = undefined;
  ctx.file.speechReviewSummary = undefined;
  ctx.file.speechReviewFile = undefined;
  ctx.file.speechReviewOriginalFile = undefined;
  try {
    output = await adapter.transcribe({
      ...ctx,
      signal,
      onDiagnostics: (value) => {
        mergeDiagnostics(value);
        ctx.onDiagnostics?.(value);
      },
    });
  } finally {
    ctx.file.speechReviewStage = undefined;
    release();
  }
  ctx.onActivity?.({ phase: 'checking', units: [] });
  await runMissedSpeechCheck(ctx.file, diagnostics, signal);
  ctx.event.sender.send('taskFileChange', { ...ctx.file });
  return output;
}

export async function routeTranscription(
  ctx: TranscribeContext,
): Promise<string> {
  const activity = getTaskContext()?.activity?.start(
    'extractSubtitle',
    'checking',
  );
  const sender = ctx.event.sender;
  // Adapters can finish recognition before final diagnostics. Publish done only once.
  const event = {
    ...ctx.event,
    sender: {
      send(channel: string, ...args: any[]) {
        if (
          channel === 'taskFileChange' &&
          args[0]?.extractSubtitle === 'done'
        ) {
          args[0] = { ...args[0], extractSubtitle: 'loading' };
        }
        if (channel === 'taskProgressChange' && args[1] === 'extractSubtitle') {
          args[2] = Math.min(99, args[2]);
        }
        sender.send(channel, ...args);
      },
    },
  } as typeof ctx.event;
  try {
    const result = await transcribe({
      ...ctx,
      event,
      onActivity: (detail) => {
        activity?.update(detail);
        ctx.onActivity?.(detail);
      },
    });
    throwIfSignalCancelled(ctx.signal ?? getTaskContext()?.signal);
    sender.send('taskFileChange', { ...ctx.file, extractSubtitle: 'done' });
    activity?.finish();
    return result;
  } catch (error) {
    activity?.finish(
      (ctx.signal ?? getTaskContext()?.signal)?.aborted ||
        isWhisperAbortError(error)
        ? 'cancelled'
        : 'error',
    );
    throw error;
  }
}
