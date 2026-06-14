import type { EngineStatus } from '../../../types/engine';
import { generateSubtitleWithBuiltinWhisper } from '../subtitleGenerator';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

export const builtinEngineAdapter: TranscriptionEngineAdapter = {
  id: 'builtin',
  displayName: 'whisper.cpp (builtin)',
  requiresRuntime: false,

  async isAvailable(): Promise<EngineStatus> {
    return { state: 'ready' };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return generateSubtitleWithBuiltinWhisper(
      ctx.event,
      ctx.file,
      ctx.formData,
    );
  },

  cancelActive(): void {
    // builtin 经 whisperParams.signal 原生中断，无需额外动作。
  },
};
