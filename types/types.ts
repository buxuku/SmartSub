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
  /** qwen 引擎包（sherpa-onnx，与 funasr 同库）是否已安装 */
  qwenEngineInstalled?: boolean;
  /** qwen 共用 silero VAD 是否已安装 */
  qwenVadInstalled?: boolean;
  /** 已安装的 qwen 模型 id（如 ['qwen3-asr-0.6b']） */
  qwenModelsInstalled?: string[];
  /** qwen 模型根目录（固定路径，仅展示用，不可更改） */
  qwenModelsPath?: string;
  /** fireRed 引擎包（sherpa-onnx，与 funasr 同库）是否已安装 */
  fireRedEngineInstalled?: boolean;
  /** fireRed 共用 silero VAD 是否已安装 */
  fireRedVadInstalled?: boolean;
  /** 已安装的 fireRed 模型 id（如 ['fire-red-asr-large-zh-en']） */
  fireRedModelsInstalled?: string[];
  /** fireRed 模型根目录（固定路径，仅展示用，不可更改） */
  fireRedModelsPath?: string;
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
  /** 校对用无损中间态 sidecar，保存源文/译文/时间轴，避免直接读写有损交付物。 */
  proofreadDataFile?: string;
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
  /** 任务类型（运行时由任务携带）：用于区分源字幕是 ASR 生成还是用户导入。 */
  taskType?: TaskProjectType;
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
  /** 生成字幕时单条字幕最大显示字数 / 宽度；0 或空表示沿用引擎默认断句。 */
  maxSubtitleChars?: number;
  /** 中文标点去除（任务级开关）：开启后把中文标点替换为空格。作用于源字幕(中文源)与译文(中文目标)。缺省关闭。 */
  removeChinesePunctuation?: boolean;
}
