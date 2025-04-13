import { Provider } from '../../../types/provider';

export type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
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
    modelsPath: string;
    maxContext?: number;
    useCustomTempDir?: boolean;
    customTempDir?: string;
  };
  providerVersion?: number;
  logs: LogEntry[];
  [key: string]: any;
};
