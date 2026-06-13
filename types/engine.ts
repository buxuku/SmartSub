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
  version: string;
  platform: string;
  sha256: string;
  installedAt: string;
}

export type PyEngineDownloadSource = 'github' | 'ghproxy';

export interface PyEngineDownloadProgress {
  status: 'idle' | 'downloading' | 'extracting' | 'completed' | 'error';
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
}
