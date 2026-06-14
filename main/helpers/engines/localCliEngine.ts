import type { EngineStatus } from '../../../types/engine';
import { store } from '../storeManager';
import {
  generateSubtitleWithLocalWhisper,
  cancelLocalCliTranscription,
} from '../subtitleGenerator';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

export const localCliEngineAdapter: TranscriptionEngineAdapter = {
  id: 'localCli',
  displayName: 'Local Whisper CLI',
  requiresRuntime: false,

  async isAvailable(): Promise<EngineStatus> {
    const whisperCommand = store.get('settings')?.whisperCommand;
    if (!whisperCommand?.trim()) {
      return {
        state: 'not_installed',
        message: 'Whisper command is not configured',
      };
    }
    return { state: 'ready' };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return generateSubtitleWithLocalWhisper(ctx.event, ctx.file, ctx.formData);
  },

  cancelActive(): void {
    cancelLocalCliTranscription();
  },
};
