import { getEngineAdapterForTask } from './engines/registry';
import { getTaskContext } from './taskContext';
import type { TranscribeContext } from './engines/types';
import type { TranscriptionEngine } from '../../types/engine';
import {
  createSerialTaskRunner,
  shouldSerializeTranscriptionEngine,
} from './transcriptionConcurrency';

const runSerializedTranscription = createSerialTaskRunner();

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
  const transcribe = () =>
    adapter.transcribe({
      ...ctx,
      signal: ctx.signal ?? getTaskContext()?.signal,
    });

  // 取消信号统一在此从任务上下文注入，引擎以 ctx.signal 为准。
  // faster-whisper / sherpa 系共享单 runtime，只串行真正的 ASR 阶段；
  // 音频提取和翻译仍由任务队列按 maxConcurrentTasks 并发执行。
  if (shouldSerializeTranscriptionEngine(adapter.id)) {
    return runSerializedTranscription(transcribe);
  }

  return transcribe();
}

export { shouldSerializeTranscriptionEngine } from './transcriptionConcurrency';
