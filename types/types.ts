import type { EngineStatus, TranscriptionEngine } from './engine';
import type {
  DubbingEngineSelection,
  DubbingCloneQuality,
  DubbingOverflowMode,
  DubbingOverlapMode,
} from './dubbing';

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
  /** 配音附加阶段状态（运行时同其余阶段字段为 ''|loading|done|error 字符串） */
  dubbing?: boolean;
  /** 合成附加阶段状态（同上字符串状态机约定） */
  composeVideo?: boolean;
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
  /**
   * 人工检查点状态（'' 未到达 | 'review' 待校对 | 'passed' 已通过）。
   * review 不参与启动时的中断标记（非 loading），跨重启保留。
   */
  subtitleGate?: '' | 'review' | 'passed';
  dubbingGate?: '' | 'review' | 'passed';
  /**
   * 配对模式（视频+字幕混合输入）：随媒体文件携带的既有字幕路径。
   * 存在且文件有效时跳过提取/听写，直接以它为源字幕进入翻译/配音/合成。
   */
  providedSubtitlePath?: string;
  /** 配音阶段：持久化会话 id（重试续跑已完成行、工作台回开检视） */
  dubbingSessionId?: string;
  /** 配音阶段产物：完整配音轨 wav（会话目录内，锚定媒体时间轴） */
  dubbedTrackPath?: string;
  /** 配音阶段交付物：任务无合成阶段时导出到输入文件旁的 `<名>-dubbed.wav` */
  dubbedAudioPath?: string;
  /** 配音阶段产物：时移发生时的顺延版字幕（合成阶段优先烧录它） */
  shiftedSubtitlePath?: string;
  /** 合成阶段产物：成品视频路径 */
  finalVideoPath?: string;
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

/**
 * 任务级配音附加阶段配置（与工作台 DubbingConfig 同构的子集）：
 * 文本源自动解析（纯译文优先）、输出恒为配音轨（视频封装交给合成阶段）。
 */
export interface PipelineDubConfig {
  engine: DubbingEngineSelection;
  voice: string;
  /** 整体语速（1 = 原速） */
  globalSpeed: number;
  cloneQuality?: DubbingCloneQuality;
  /** 本地并行合成路数（1–3，默认 1） */
  localConcurrency?: number;
  /** 全自动过长兜底（默认截断） */
  overflow?: DubbingOverflowMode;
  /** 重叠 cue 消解（默认顺延） */
  overlapMode?: DubbingOverlapMode;
}

/** 任务级合成附加阶段配置（矩阵其余维度按上游产物自动推导） */
export interface PipelineComposeConfig {
  /** 字幕并入方式（默认 hard 烧录；none 仅换配音轨，要求配音阶段开启） */
  subtitle: 'hard' | 'soft' | 'none';
}

/** 人工检查点档位 */
export type PipelineGateMode = 'manual' | 'auto';

/**
 * 人工把关配置（缺省 auto 全自动）：
 * subtitle=字幕校对（字幕段成功后、配音/合成前），dubbing=配音确认（配音后、合成前）。
 */
export interface PipelineGatesConfig {
  subtitle?: PipelineGateMode;
  dubbing?: PipelineGateMode;
}

export interface IFormData {
  /** 任务类型（运行时由任务携带）：用于区分源字幕是 ASR 生成还是用户导入。 */
  taskType?: TaskProjectType;
  /** 创建来源配方名（向导应用用户配方时随任务快照记录，任务页标题展示） */
  recipeName?: string;
  /** 配音附加阶段（缺省不配音） */
  dub?: PipelineDubConfig;
  /** 合成附加阶段（缺省不合成；仅媒体输入任务可用） */
  compose?: PipelineComposeConfig;
  /** 人工把关（缺省全自动；仅带附加阶段的任务有意义） */
  gates?: PipelineGatesConfig;
  /** 转写引擎（逐任务选择，缺省 builtin）。 */
  transcriptionEngine?: TranscriptionEngine;
  /** 转写模型名（引擎相关；云引擎为服务商实例内的模型 id）。 */
  model?: string;
  /** 云端听写：选中的云 ASR 服务商实例 id（transcriptionEngine==='cloud' 时必填）。 */
  asrProviderId?: string;
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
  /**
   * 生成字幕时单条字幕最大显示字数 / 宽度（CJK 记 2、其余记 1）。
   * 0 或空 = 智能断句（引擎默认）；-1 = 不限制长度（仅按停顿/标点断句，不按字数硬切）；
   * 正数 = 自定义上限（超出时在标点或词边界处拆分）。
   */
  maxSubtitleChars?: number;
  /** 中文标点去除（任务级开关）：开启后把中文标点替换为空格。作用于源字幕(中文源)与译文(中文目标)。缺省关闭。 */
  removeChinesePunctuation?: boolean;
}
