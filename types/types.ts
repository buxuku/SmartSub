export interface ISystemInfo {
  modelsInstalled: string[];
  modelsPath: string;
  downloadingModels: string[];
}

export type StepKeyPossibleValues = 'loading' | 'done' | 'error';

// 任务类型枚举
export type ITaskType =
  | 'generateAndTranslate'
  | 'generateOnly'
  | 'translateOnly';

export interface IFiles {
  uuid: string;
  filePath: string;
  fileName: string;
  fileExtension: string;
  directory: string;
  extractAudio?: StepKeyPossibleValues;
  extractSubtitle?: StepKeyPossibleValues;
  translateSubtitle?: StepKeyPossibleValues;
  audioFile?: string;
  srtFile?: string;
  tempSrtFile?: string;
  tempAudioFile?: string;
  translatedSrtFile?: string;
  tempTranslatedSrtFile?: string;

  taskType?: ITaskType;
  formData?: any; // 任务配置
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
}
