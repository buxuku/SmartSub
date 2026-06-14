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
}

export interface RemoteEngineManifest {
  engineVersion: string;
  protocolVersion: number;
  builtAt: string;
  gitSha?: string;
  engines: string[];
  artifacts: Record<string, { sizeBytes: number; sha256: string }>;
}

export interface PyEngineUpdateInfo {
  installed: boolean;
  hasUpdate: boolean;
  localManifest: PyEngineManifest | null;
  remoteManifest: RemoteEngineManifest | null;
  remoteHash: string | null;
  protocolSupported: boolean;
}

export type PyEngineDownloadSource = 'github' | 'ghproxy';

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
