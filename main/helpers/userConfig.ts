import { store } from './store';
import { defaultUserConfig } from './utils';
import {
  DEFAULT_TRANSCRIPTION_PROVIDER,
  normalizeTranscriptionProvider,
  resetRemovedTranscriptionModel,
} from '../../types';

const JAPANESE_DEFAULTS_MIGRATED = 'japaneseDefaultsMigrated';

export function getUserConfigWithJapaneseDefaults(): Record<string, any> {
  const storedConfig = store.get('userConfig') || {};
  const settings = (store.get('settings') || {}) as Record<string, any>;
  const rawProvider =
    storedConfig.transcriptionProvider ||
    (settings.useLocalWhisper
      ? 'local-whisper-command'
      : DEFAULT_TRANSCRIPTION_PROVIDER);
  const normalizedProvider = normalizeTranscriptionProvider(rawProvider);
  const mergedConfig = {
    ...defaultUserConfig,
    ...storedConfig,
    transcriptionProvider: normalizedProvider,
    model: resetRemovedTranscriptionModel(storedConfig.model),
  };
  const didNormalizeConfig =
    rawProvider !== normalizedProvider ||
    storedConfig.model !== mergedConfig.model;

  if (
    !settings[JAPANESE_DEFAULTS_MIGRATED] &&
    mergedConfig.sourceLanguage === 'en' &&
    mergedConfig.targetLanguage === 'zh'
  ) {
    const migratedConfig = {
      ...mergedConfig,
      sourceLanguage: 'ja',
      targetLanguage: 'zh',
    };

    store.set('userConfig', migratedConfig);
    store.set('settings', {
      ...settings,
      [JAPANESE_DEFAULTS_MIGRATED]: true,
    });

    return migratedConfig;
  }

  if (didNormalizeConfig) {
    store.set('userConfig', mergedConfig);
  }

  return mergedConfig;
}
