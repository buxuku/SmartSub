import { StoreType, TranscriptionEngine } from './store/types';

/**
 * 解析当前生效的转写引擎。
 * transcriptionEngine 未设置时由旧版 useLocalWhisper 推导,
 * 保证老用户升级后行为不变。
 */
export function resolveTranscriptionEngine(
  settings: StoreType['settings'] | undefined,
): TranscriptionEngine {
  if (settings?.transcriptionEngine) {
    return settings.transcriptionEngine;
  }
  return settings?.useLocalWhisper ? 'localCli' : 'builtin';
}
