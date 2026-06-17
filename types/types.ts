import type { EngineStatus } from './engine';

export interface ISystemInfo {
  modelsInstalled: string[];
  modelsPath: string;
  downloadingModels: string[];
  totalMemoryGB?: number;
  fasterWhisperModelsInstalled?: string[];
  fasterWhisperModelsPath?: string;
  pythonEngineStatus?: EngineStatus;
  /** funasr 引擎包是否已安装 */
  funasrEngineInstalled?: boolean;
  /** funasr 共用 VAD 是否已安装 */
  funasrVadInstalled?: boolean;
  /** 已安装的 funasr ASR 模型 id（如 ['sensevoice-small','paraformer-zh']） */
  funasrAsrModelsInstalled?: string[];
  /** funasr 模型根目录（固定路径，仅展示用，不可更改） */
  funasrModelsPath?: string;
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
  /** 该文件走了内封软字幕直提（跳过抽音频 + ASR）：用于任务列表标识 */
  embeddedSubtitle?: boolean;
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
