import Store from 'electron-store';
import { StoreType } from './types';
import { defaultUserConfig, isAppleSilicon } from '../utils';
import path from 'path';
import { app } from 'electron';

const defaultWhisperCommand = isAppleSilicon()
  ? 'whisper "${audioFile}" --model ${whisperModel} --output_format srt --output_dir "${outputDir}" --language ${sourceLanguage}'
  : 'whisper "${audioFile}" --model ${whisperModel} --device cuda --output_format srt --output_dir "${outputDir}" --language ${sourceLanguage}';

export const store = new Store<StoreType>({
  defaults: {
    userConfig: defaultUserConfig,
    translationProviders: [],
    settings: {
      language: 'zh',
      useLocalWhisper: false,
      whisperCommand: defaultWhisperCommand,
      builtinWhisperCommand: defaultWhisperCommand,
      useCuda: true,
      modelsPath: path.join(app.getPath('userData'), 'whisper-models'),
      maxContext: -1,
    },
    logs: [],
  },
});
