export interface ISystemInfo {
  modelsInstalled: string[];
  modelsPath: string;
  downloadingModels: string[];
  totalMemoryGB?: number;
}

export type TaskStepStatus = 'loading' | 'done' | 'error';

export interface IFiles {
  uuid: string;
  filePath: string;
  fileName: string;
  fileExtension: string;
  directory: string;
  extractAudio?: TaskStepStatus;
  extractSubtitle?: TaskStepStatus;
  translateSubtitle?: TaskStepStatus;
  prepareSubtitle?: TaskStepStatus;
  processFile?: TaskStepStatus;
  extractAudioProgress?: number;
  extractSubtitleProgress?: number;
  translateSubtitleProgress?: number;
  prepareSubtitleProgress?: number;
  processFileProgress?: number;
  extractAudioError?: string;
  extractSubtitleError?: string;
  translateSubtitleError?: string;
  prepareSubtitleError?: string;
  processFileError?: string;
  audioFile?: string;
  srtFile?: string;
  tempSrtFile?: string;
  tempAudioFile?: string;
  translatedSrtFile?: string;
  tempTranslatedSrtFile?: string;
  [key: string]: unknown;
}

export interface IFormData {
  translateContent:
    | 'onlyTranslate'
    | 'sourceAndTranslate'
    | 'translateAndSource';
  targetSrtSaveOption: string;
  customTargetSrtFileName: string;
  sourceLanguage: string;
  targetLanguage: string;
  translateRetryTimes: string;
  subtitleOutputFormat?: 'srt' | 'vtt' | 'ass' | 'lrc' | 'txt';
}
