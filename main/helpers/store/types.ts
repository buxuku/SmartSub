import { Provider, CustomParameterConfig } from '../../../types/provider';
import { ProofreadHistory, ProofreadTask } from '../../../types/proofread';

export type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
};

/** 字幕转写引擎:内置 whisper.cpp / Python faster-whisper / 本地命令行 */
export type TranscriptionEngine = 'builtin' | 'fasterWhisper' | 'localCli';

export type StoreType = {
  translationProviders: Provider[];
  userConfig: Record<string, any>;
  settings: {
    whisperCommand: string;
    language: string;
    /** 旧版开关,语义等同 transcriptionEngine === 'localCli',保留兼容 */
    useLocalWhisper: boolean;
    transcriptionEngine?: TranscriptionEngine;
    fasterWhisperDevice?: 'auto' | 'cpu' | 'cuda';
    fasterWhisperComputeType?: string;
    builtinWhisperCommand: string;
    useCuda: boolean;
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
  customParameters?: Record<string, CustomParameterConfig>;
  proofreadHistories?: ProofreadHistory[]; // 旧版，保留兼容
  proofreadTasks?: ProofreadTask[]; // 新版批量任务
  [key: string]: any;
};
