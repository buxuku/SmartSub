import type { EngineStatus, TranscriptionEngine } from './engine';

export interface ISystemInfo {
  modelsInstalled: string[];
  modelsPath: string;
  downloadingModels: string[];
  totalMemoryGB?: number;
  fasterWhisperModelsInstalled?: string[];
  fasterWhisperModelsPath?: string;
  transcriptionEngine?: TranscriptionEngine;
  pythonEngineStatus?: EngineStatus;
}

export interface IFiles {
  uuid: string;
  filePath: string;
  fileName: string;
  fileExtension: string;
  directory: string;
  extractAudio?: boolean;
  extractSubtitle?: boolean;
  translateSubtitle?: boolean;
  audioFile?: string;
  srtFile?: string;
  tempSrtFile?: string;
  tempAudioFile?: string;
  translatedSrtFile?: string;
  tempTranslatedSrtFile?: string;
  /** 本次转写实际使用的后端标签（如 "CUDA 12.4.0" / "Vulkan" / "CPU"） */
  whisperBackend?: string;
}

export type TaskProjectType =
  | 'generateAndTranslate'
  | 'generateOnly'
  | 'translateOnly';

/** 一次任务工程：任务维度记录，下挂文件列表 */
export interface TaskProject {
  id: string;
  /** 默认「时间 + 第一个文件名」，用户可改 */
  name: string;
  taskType: TaskProjectType;
  files: IFiles[];
  createdAt: number;
  updatedAt: number;
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
