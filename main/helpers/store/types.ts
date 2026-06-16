import { Provider, CustomParameterConfig } from '../../../types/provider';
import { ProofreadHistory, ProofreadTask } from '../../../types/proofread';
import { IFiles, TaskProject } from '../../../types';
import { WorkItem } from '../../../types/workItem';
import type { TranscriptionEngine } from '../../../types/engine';
import {
  GpuMode,
  AddonLoadResultInfo,
  AddonLoadHistoryEntry,
} from '../../../types/addon';

export type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
  /** 任务工程日志归属；系统日志（updater 等）无此字段 */
  projectId?: string;
};

export type StoreType = {
  translationProviders: Provider[];
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
    vadThreshold: number;
    vadMinSpeechDuration: number;
    vadMinSilenceDuration: number;
    vadMaxSpeechDuration: number;
    vadSpeechPad: number;
    vadSamplesOverlap: number;
    /** 抗幻觉/抗重复：开启后断开上文条件并抑制重复（builtin: max_context=0；faster-whisper: condition_on_previous_text=false + no_repeat_ngram/repetition_penalty 等）。默认关闭，按需开启。 */
    reduceRepetition?: boolean;
    transcriptionEngine?: TranscriptionEngine;
    fasterWhisperDevice?: 'auto' | 'cpu' | 'cuda';
    fasterWhisperComputeType?: string;
    fasterWhisperModelsPath?: string;
    /** FunASR(SenseVoice via sherpa-onnx) 推理 provider；P1 仅 cpu 落地，cuda/coreml 预留 */
    funasrProvider?: 'cpu' | 'cuda' | 'coreml';
    /** FunASR 逆文本归一化（数字/标点），默认开启 */
    funasrUseItn?: boolean;
    /** FunASR 解码线程数，默认 2 */
    funasrNumThreads?: number;
    /** 全局网络代理模式（none=直连；custom=手动 URL） */
    proxyMode?: 'none' | 'custom';
    /** custom 模式的代理 URL，如 http://user:pass@host:port */
    proxyUrl?: string;
    /** 可选 NO_PROXY 列表（逗号分隔），默认 localhost,127.0.0.1 */
    proxyNoProxy?: string;
    /** 任务列表视图：list=列表，grid=网格（全局统一，跨重启保留） */
    taskViewMode?: 'list' | 'grid';
    /** 关闭窗口行为：smart=有任务转后台/空闲退出，background=始终后台，quit=始终退出（仅 macOS 生效，Win/Linux 固定兜底） */
    closeAction?: 'smart' | 'background' | 'quit';
    /** 首次「转入后台」提示是否已展示（勾「不再提示」后置 true） */
    closeHintShown?: boolean;
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
  [key: string]: any;
};
