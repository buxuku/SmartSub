import { getEngineAdapterForTask } from './engines/registry';
import { acquireTranscribeSlot } from './engines/transcribeGate';
import { getTaskContext } from './taskContext';
import { logMessage } from './storeManager';
import type { TranscribeContext } from './engines/types';
import type { TranscriptionEngine } from '../../types/engine';

export async function routeTranscription(
  ctx: TranscribeContext,
): Promise<string> {
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
  const release = await acquireTranscribeSlot(adapter.id, signal);
  const waitedMs = Date.now() - waitStart;
  if (waitedMs > 1000) {
    logMessage(
      `transcribe slot acquired for ${ctx.file.fileName} after ${Math.round(waitedMs / 1000)}s queue (engine=${adapter.id})`,
      'info',
    );
  }
  try {
    return await adapter.transcribe({ ...ctx, signal });
  } finally {
    release();
  }
}
