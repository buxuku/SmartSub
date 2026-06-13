import type { EngineStatus } from '../../../types/engine';
import {
  isPyEngineInstalled,
  readPyEngineManifest,
} from '../pythonRuntime/paths';
import {
  generateSubtitleWithFasterWhisper,
  cancelFasterWhisperTranscription,
} from '../subtitleGenerator';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

export const fasterWhisperEngineAdapter: TranscriptionEngineAdapter = {
  id: 'fasterWhisper',
  displayName: 'faster-whisper',
  requiresRuntime: true,

  async isAvailable(): Promise<EngineStatus> {
    // 安装状态仅以「运行时已落盘 + manifest 存在」为准；运行时探活（冷启动 ping）
    // 推迟到真正转写时进行，避免 PyInstaller 首次冷启动耗时超过探活超时，
    // 被误报为「安装异常 / ping timeout」（实际安装是成功的）。
    if (!isPyEngineInstalled()) {
      return {
        state: 'not_installed',
        message: 'Python engine runtime is not installed',
      };
    }
    const manifest = readPyEngineManifest();
    return { state: 'ready', version: manifest?.version };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return generateSubtitleWithFasterWhisper(ctx.event, ctx.file, ctx.formData);
  },

  cancelActive(): void {
    cancelFasterWhisperTranscription();
  },
};
