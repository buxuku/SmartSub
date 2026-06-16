export type TranscriptionEngine = 'builtin' | 'fasterWhisper' | 'localCli';

export type EngineStatusState =
  | 'ready'
  | 'not_installed'
  | 'downloading'
  | 'error'
  | 'checking';

export interface EngineStatus {
  state: EngineStatusState;
  version?: string;
  message?: string;
}

export interface PyEngineManifest {
  version: string; // 兼容历史（可能为 'latest'）
  platform: string;
  sha256: string;
  installedAt: string;
  engineVersion?: string;
  protocolVersion?: number;
  builtAt?: string;
  gitSha?: string;
  engineId?: string; // 'faster-whisper' 等（三层架构按引擎区分包）
  pythonAbi?: string; // 'cp312'，需与内置基座 ABI 一致
}

export interface RemoteEngineManifest {
  engineVersion: string;
  protocolVersion: number;
  builtAt: string;
  gitSha?: string;
  engines: string[];
  artifacts: Record<string, { sizeBytes: number; sha256: string }>;
  pythonVersion?: string;
  pythonAbi?: string;
  engineId?: string;
}

/** 内置/可升级 Python 基座的本地 manifest。 */
export interface PyBaseManifest {
  pythonVersion: string; // '3.12.10'
  platform: string;
  sha256?: string;
  installedAt: string;
  source: 'builtin' | 'downloaded';
}

/** P0 仅 faster-whisper；P1/P2 扩展 funasr/qwen。 */
export type PyEngineId = 'faster-whisper';

export interface PyEngineUpdateInfo {
  installed: boolean;
  hasUpdate: boolean;
  localManifest: PyEngineManifest | null;
  remoteManifest: RemoteEngineManifest | null;
  remoteHash: string | null;
  protocolSupported: boolean;
}

export type PyEngineDownloadSource = 'github' | 'ghproxy' | 'gitcode';

export interface PyEngineDownloadProgress {
  status:
    | 'idle'
    | 'downloading'
    | 'extracting'
    | 'verifying'
    | 'completed'
    | 'error';
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
}
