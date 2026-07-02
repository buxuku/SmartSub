export type TranscriptionEngine =
  | 'builtin'
  | 'fasterWhisper'
  | 'funasr'
  | 'qwen'
  | 'fireRedAsr'
  | 'localCli'
  /** 云端听写（在线 ASR）：单一适配器，按 asrProviderId 实例分发到具体 service。 */
  | 'cloud';

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
  /** 已安装的运行时变体：cpu=默认包，cuda=Full GPU 包（仅 win/linux）。 */
  variant?: PyEngineVariant;
}

/**
 * 运行时变体：
 * - cpu：默认包（原产物名，不带后缀），所有平台可用；
 * - cuda：Full GPU(CUDA12) 包（产物名带 -cuda 后缀，捆绑 cuBLAS/cuDNN），仅 windows-x64 / linux-x64。
 */
export type PyEngineVariant = 'cpu' | 'cuda';

export interface PyEngineManifest {
  version: string; // 兼容历史（可能为 'latest'）
  platform: string;
  sha256: string;
  installedAt: string;
  engineVersion?: string;
  protocolVersion?: number;
  builtAt?: string;
  gitSha?: string;
  engineId?: string; // 'faster-whisper'（运行时按引擎区分目录）
  pythonAbi?: string; // 'cp312'，与内嵌 PBS 解释器 ABI 一致
  /** 已安装变体；老安装缺失时按 'cpu' 兜底（原产物即 CPU 包）。 */
  variant?: PyEngineVariant;
}

export interface RemoteEngineArtifact {
  sizeBytes: number;
  sha256: string;
}

/**
 * 单自包含运行时信息（内嵌 PBS 解释器 + site-packages + main.py），按 (os,arch) 分平台。
 * 取代旧的「可下载基座包 + 可重定位引擎包」两段式产物。
 */
export interface RemoteRuntimeInfo {
  /** 命名模板（如 smartsub-faster-whisper-runtime-<suffix>.tar.gz），仅供展示/排错。 */
  artifactPattern?: string;
  /** 按平台 suffix（macos-arm64 / windows-x64 …）映射到产物大小与哈希。 */
  artifacts: Record<string, RemoteEngineArtifact>;
}

export interface RemoteEngineManifest {
  engineVersion: string;
  protocolVersion: number;
  builtAt: string;
  gitSha?: string;
  engines: string[];
  pythonVersion?: string;
  pythonAbi?: string;
  engineId?: string;
  /** 单自包含运行时产物（按平台）。老 release 可能缺失，消费方需容忍 undefined。 */
  runtime?: RemoteRuntimeInfo;
}

/** 可独立下载的 Python 引擎运行时标识。faster-whisper 是唯一 Python 引擎（funasr/qwen/firered 已改用内置 sherpa-onnx 原生库）。 */
export type PyEngineId = 'faster-whisper';

export interface PyEngineUpdateInfo {
  installed: boolean;
  hasUpdate: boolean;
  localManifest: PyEngineManifest | null;
  remoteManifest: RemoteEngineManifest | null;
  remoteHash: string | null;
  protocolSupported: boolean;
  /** 本次更新检查所针对的变体（默认取已安装变体，未安装时为 'cpu'）。 */
  variant?: PyEngineVariant;
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
  /** 多引擎下载时标识是哪个引擎运行时（渲染层据此路由进度）。 */
  engineId?: PyEngineId;
}
