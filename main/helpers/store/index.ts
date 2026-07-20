import Store from 'electron-store';
import { StoreType } from './types';
import { defaultUserConfig, isAppleSilicon } from '../utils';

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
      gpuMode: 'auto' as const,
      macAccelMode: 'auto' as const,
      // modelsPath 不再写入 defaults：绝对默认路径会随任意一次 setSettings 被动
      // 持久化，导致与「用户主动自定义」不可区分，阻断统一存储目录跟随（design D4）。
      maxContext: -1,
      useCustomTempDir: false,
      customTempDir: '',
      useVAD: true,
      checkUpdateOnStartup: true,
      preventSleepDuringTask: true,
      vadThreshold: 0.5,
      vadMinSpeechDuration: 250,
      vadMinSilenceDuration: 100,
      vadMaxSpeechDuration: 0,
      vadSpeechPad: 200,
      vadSamplesOverlap: 0.1,
      reduceRepetition: false,
      fasterWhisperDevice: 'auto' as const,
      fasterWhisperComputeType: 'auto',
      proxyMode: 'none' as const,
      taskViewMode: 'list' as const,
      closeAction: 'smart' as const,
      closeHintShown: false,
    },
    mergePreferences: {
      outputMode: 'hardcode' as const,
      videoQuality: 'original' as const,
      encoderMode: 'cpu' as const,
    },
    mergeStylePresets: [],
    taskRecipes: [],
    glossaries: [],
  },
});
