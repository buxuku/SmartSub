import { Provider, CustomParameterConfig } from '../../../types/provider';
import { ProofreadHistory, ProofreadTask } from '../../../types/proofread';
import { IFiles, TaskProject } from '../../../types';
import { WorkItem } from '../../../types/workItem';
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
