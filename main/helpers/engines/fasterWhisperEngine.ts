import type { EngineStatus } from '../../../types/engine';
import { getPythonRuntimeManager } from '../pythonRuntime';
import {
  isPyEngineInstalled,
  readPyEngineManifest,
} from '../pythonRuntime/paths';
import {
  generateSubtitleWithFasterWhisper,
  cancelFasterWhisperTranscription,
} from '../subtitleGenerator';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

/** Strip ggml quantization suffix (-q5_0 etc.) for faster-whisper model id. */
export function toFasterWhisperModelId(ggmlName?: string): string {
  return (ggmlName || 'base').toLowerCase().replace(/-q\d+_\d+$/, '');
}

export const fasterWhisperEngineAdapter: TranscriptionEngineAdapter = {
  id: 'fasterWhisper',
  displayName: 'faster-whisper',
  requiresRuntime: true,

  async isAvailable(): Promise<EngineStatus> {
    if (!isPyEngineInstalled()) {
      return {
        state: 'not_installed',
        message: 'Python engine runtime is not installed',
      };
    }
    try {
      const manager = getPythonRuntimeManager();
      const info = await manager.ensureStarted();
      if (!info.engines?.faster_whisper) {
        return {
          state: 'error',
          message:
            'faster-whisper is not available in the python engine runtime',
        };
      }
      const manifest = readPyEngineManifest();
      return { state: 'ready', version: manifest?.version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { state: 'error', message };
    }
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return generateSubtitleWithFasterWhisper(ctx.event, ctx.file, ctx.formData);
  },

  cancelActive(): void {
    cancelFasterWhisperTranscription();
  },
};
