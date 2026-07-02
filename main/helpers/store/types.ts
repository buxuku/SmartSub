import { Provider, CustomParameterConfig } from '../../../types/provider';
import type { AsrProvider } from '../../../types/asrProvider';
import { ProofreadHistory, ProofreadTask } from '../../../types/proofread';
import { IFiles, TaskProject } from '../../../types';
import { WorkItem } from '../../../types/workItem';
import type { TranscriptionEngine } from '../../../types/engine';
import {
  GpuMode,
  AddonLoadResultInfo,
  AddonLoadHistoryEntry,
} from '../../../types/addon';
import type { DownloadEndpointConfig } from '../../../types/downloadConfig';

export type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
  /** 任务工程日志归属；系统日志（updater 等）无此字段 */
  projectId?: string;
};

export type StoreType = {
  translationProviders: Provider[];
  /** 云端听写（在线 ASR）服务商实例列表（多实例，含凭据）。缺省未定义时按 [] 处理。 */
  asrProviders?: AsrProvider[];
  userConfig: Record<string, any>;
  settings: {
    whisperCommand: string;
    language: string;
    useLocalWhisper: boolean;
    builtinWhisperCommand: string;
    useCuda: boolean;
    /** GPU 加速模式（取代 useCuda；useCuda 保留仅为回滚安全） */
    gpuMode?: GpuMode;
    /** gpuMode 迁移一次性通知标记：false=待通知，true=已通知 */
    gpuMigrationNotified?: boolean;
    modelsPath: string;
    maxContext?: number;
    useCustomTempDir?: boolean;
    customTempDir?: string;
    useVAD: boolean;
    checkUpdateOnStartup: boolean;
    preventSleepDuringTask: boolean;
    vadThreshold: number;
    vadMinSpeechDuration: number;
    vadMinSilenceDuration: number;
    vadMaxSpeechDuration: number;
    vadSpeechPad: number;
    vadSamplesOverlap: number;
    /** 抗幻觉/抗重复：开启后断开上文条件并抑制重复（builtin: max_context=0；faster-whisper: condition_on_previous_text=false + no_repeat_ngram/repetition_penalty 等）。默认关闭，按需开启。 */
    reduceRepetition?: boolean;
    /*
     * 字幕效果档位（SubtitleOutcome）是**任务级**配置，存在 userConfig.subtitleOutcome（formData），
     * 与 maxContext/useVAD/reduceRepetition 同源、按「上次使用」记忆，不在全局 settings 里。
     * 把这些底层旋钮收敛为意图单选，按引擎差异化派生底层参数；取值与映射见
     * main/helpers/engines/outcomePresets.ts。
     */
    /**
     * 任务默认引擎+模型的"上次使用"记忆（全局单条，三者作为整体，避免引擎/模型失配）。
     * 云引擎(engine==='cloud')时 asrProviderId 标识具体服务商实例。
     */
    lastUsedTranscription?: {
      engine: TranscriptionEngine;
      model?: string;
      asrProviderId?: string;
    };
    fasterWhisperDevice?: 'auto' | 'cpu' | 'cuda';
    fasterWhisperComputeType?: string;
    fasterWhisperModelsPath?: string;
    /** funasr 模型根目录覆盖；缺省回退 userData/models/funasr */
    funasrModelsPath?: string;
    /** qwen 模型根目录覆盖；缺省回退 userData/models/qwen */
    qwenModelsPath?: string;
    /** fireRed 模型根目录覆盖；缺省回退 userData/models/firered */
    fireRedModelsPath?: string;
    /** FunASR(SenseVoice via sherpa-onnx) 推理 provider；P1 仅 cpu 落地，cuda/coreml 预留 */
    funasrProvider?: 'cpu' | 'cuda' | 'coreml';
    /** FunASR 逆文本归一化（数字/标点），默认开启 */
    funasrUseItn?: boolean;
    /** FunASR 解码线程数，默认 2 */
    funasrNumThreads?: number;
    /** Qwen3-ASR(sherpa-onnx) 推理 provider；P2 仅 cpu 落地，cuda 预留 */
    qwenProvider?: 'cpu' | 'cuda';
    /** Qwen3-ASR 解码线程数，默认 2 */
    qwenNumThreads?: number;
    /** Qwen3-ASR 最大总序列长度，默认 512（对齐 sherpa 上游） */
    qwenMaxTotalLen?: number;
    /** Qwen3-ASR 单段最大新生成 token 数，默认 128 */
    qwenMaxNewTokens?: number;
    /** Qwen3-ASR 采样温度，默认 1e-6（近贪心，确定性） */
    qwenTemperature?: number;
    /** Qwen3-ASR top-p 采样阈值，默认 0.8 */
    qwenTopP?: number;
    /** Qwen3-ASR 随机种子，默认 42 */
    qwenSeed?: number;
    /** FireRedASR-AED(sherpa-onnx) 推理 provider；本期仅 cpu 落地，cuda 预留 */
    fireRedProvider?: 'cpu' | 'cuda';
    /** FireRedASR-AED 解码线程数，默认 2 */
    fireRedNumThreads?: number;
    /** 全局网络代理模式（none=直连；custom=手动 URL） */
    proxyMode?: 'none' | 'custom';
    /** custom 模式的代理 URL，如 http://user:pass@host:port */
    proxyUrl?: string;
    /** 可选 NO_PROXY 列表（逗号分隔），默认 localhost,127.0.0.1 */
    proxyNoProxy?: string;
    /** 下载源端点（镜像/代理）用户覆盖；缺省字段走 DEFAULT_DOWNLOAD_ENDPOINTS。 */
    downloadEndpoints?: Partial<DownloadEndpointConfig>;
    /** 任务列表视图：list=列表，grid=网格（全局统一，跨重启保留） */
    taskViewMode?: 'list' | 'grid';
    /** 关闭窗口行为：smart=有任务转后台/空闲退出，background=始终后台，quit=始终退出（仅 macOS 生效，Win/Linux 固定兜底） */
    closeAction?: 'smart' | 'background' | 'quit';
    /** 首次「转入后台」提示是否已展示（勾「不再提示」后置 true） */
    closeHintShown?: boolean;
    /** 云端听写「上传第三方」隐私确认：用户勾「不再提醒」后置 true，跳过后续开跑确认。 */
    cloudUploadConsent?: boolean;
  };
  providerVersion?: number;
  logs: LogEntry[];
  lastAddonLoadResult?: AddonLoadResultInfo;
  addonLoadHistory?: AddonLoadHistoryEntry[];
  customParameters?: Record<string, CustomParameterConfig>;
  proofreadHistories?: ProofreadHistory[]; // 旧版，保留兼容
  proofreadTasks?: ProofreadTask[]; // 新版批量任务
  /** 统一工作项（P19 WorkItem） */
  workItems?: WorkItem[];
  workItemsMigrationVersion?: number;
  /** 旧版扁平任务列表（仅保留用于迁移到 taskProjects） */
  tasks?: IFiles[];
  /** 任务工程列表（任务维度，跨重启保留） */
  taskProjects?: TaskProject[];
  /**
   * 讯飞录音转写大模型进行中订单（跨会话续查）：
   * 键=`sha1(压缩音频):服务商实例id:语种档位`；重启后重跑同任务跳过上传直接续查。
   * 订单完结/失效即删；写入超 72h 惰性过期（服务端结果保留约 5 天）。
   */
  xfyunPendingOrders?: Record<
    string,
    { orderId: string; signatureRandom: string; createdAt: number }
  >;
  [key: string]: any;
};
