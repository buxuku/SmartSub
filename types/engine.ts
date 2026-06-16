export type TranscriptionEngine =
  | 'builtin'
  | 'fasterWhisper'
  | 'funasr'
  | 'localCli';

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

export interface RemoteEngineArtifact {
  sizeBytes: number;
  sha256: string;
}

export interface RemoteEnginePackage {
  engineId: string;
  /** sidecar 引擎 key（list_engines 名，如 faster_whisper / funasr） */
  sidecar: string;
  artifacts: Record<string, RemoteEngineArtifact>;
}

/** 三层 Layer1：可下载的 Python 基座包（按平台 artifacts）。 */
export interface RemoteBasePackage {
  pythonVersion: string;
  pythonAbi: string;
  pbsRelease?: string;
  artifacts: Record<string, RemoteEngineArtifact>;
}

export interface RemoteEngineManifest {
  engineVersion: string;
  protocolVersion: number;
  builtAt: string;
  gitSha?: string;
  engines: string[];
  /** 顶层 artifacts 兼容旧字段（=faster-whisper 包），多引擎读 enginePackages。 */
  artifacts: Record<string, RemoteEngineArtifact>;
  /** 三层多引擎：按 engineId 分桶的包信息（P1 起）。 */
  enginePackages?: Record<string, RemoteEnginePackage>;
  pythonVersion?: string;
  pythonAbi?: string;
  engineId?: string;
  /** 三层 Layer1：可下载基座包（按平台 artifacts）。 */
  basePackage?: RemoteBasePackage;
}

/** 内置/可升级 Python 基座的本地 manifest。 */
export interface PyBaseManifest {
  pythonVersion: string; // '3.12.10'
  platform: string;
  sha256?: string;
  installedAt: string;
  source: 'builtin' | 'downloaded';
}

/** 可独立下载的 Python 引擎包标识（与引擎仓产物 engineId 一一对应）。P2 再加 qwen。 */
export type PyEngineId = 'faster-whisper' | 'funasr';

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
  /** 多引擎下载时标识是哪个引擎包（渲染层据此路由进度）。 */
  engineId?: PyEngineId;
}

/** Layer1 基座下载进度（与引擎进度同构，无 engineId）。 */
export interface PyBaseDownloadProgress {
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

export interface PyBaseUpdateInfo {
  hasUpdate: boolean;
  localManifest: PyBaseManifest | null;
  remoteBase: RemoteBasePackage | null;
  remoteHash: string | null;
}

export interface PyBaseStatus {
  state: EngineStatusState;
  source: 'builtin' | 'downloaded' | 'none';
  pythonVersion?: string;
}
