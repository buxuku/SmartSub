import { store } from './store';
import { defaultUserConfig } from './utils';
import { DEFAULT_TRANSCRIPTION_PROVIDER } from '../../types';

const JAPANESE_DEFAULTS_MIGRATED = 'japaneseDefaultsMigrated';

export function getUserConfigWithJapaneseDefaults(): Record<string, any> {
  const storedConfig = store.get('userConfig') || {};
  const settings = store.get('settings') || {};
  const mergedConfig = {
    ...defaultUserConfig,
    ...storedConfig,
    transcriptionProvider:
      storedConfig.transcriptionProvider ||
      (settings.useLocalWhisper
        ? 'local-whisper-command'
        : DEFAULT_TRANSCRIPTION_PROVIDER),
  };

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

  return mergedConfig;
}
