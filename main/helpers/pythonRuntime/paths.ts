import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type {
  PyEngineManifest,
  PyEngineId,
  PyEngineVariant,
} from '../../../types/engine';
import { resolveReleaseBaseUrl } from '../download/sources';

/** 独立发布仓库：https://github.com/buxuku/smartsub-py-engine */
export const PY_ENGINE_REPO = 'buxuku/smartsub-py-engine';

/** 滚动 latest Release，SmartSub 始终从此 tag 拉取最新构建 */
export const PY_ENGINE_TAG = 'latest';

export function getPyEngineArtifactSuffix(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'linux') return 'linux-x64';
  throw new Error(`Unsupported platform: ${process.platform}`);
}

/**
 * Full GPU(CUDA12) 变体仅在 windows-x64 / linux-x64 发布（引擎仓 release.yml 的 gpu:true 平台）。
 * macOS 无 NVIDIA CUDA，恒为 cpu 包。
 */
export function isPyEngineVariantSupported(variant: PyEngineVariant): boolean {
  if (variant === 'cpu') return true;
  return process.platform === 'win32' || process.platform === 'linux';
}

/** 规整变体：在不支持 cuda 的平台上把 'cuda' 收敛为 'cpu'，其余原样返回。 */
export function normalizePyEngineVariant(
  variant: PyEngineVariant | undefined | null,
): PyEngineVariant {
  const v: PyEngineVariant = variant === 'cuda' ? 'cuda' : 'cpu';
  return isPyEngineVariantSupported(v) ? v : 'cpu';
}

/** GitCode 镜像 owner 与 GitHub 不同（buxuku1），repo 名相同。 */
const PY_ENGINE_REPO_SLUGS = {
  github: PY_ENGINE_REPO,
  gitcode: 'buxuku1/smartsub-py-engine',
};

export function getPyEngineReleaseBaseUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  return resolveReleaseBaseUrl(source, PY_ENGINE_REPO_SLUGS, tag);
}

export function getPyEngineChecksumsUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  return `${getPyEngineReleaseBaseUrl(source, tag)}/checksums.sha256`;
}

export function getPyEngineManifestUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  return `${getPyEngineReleaseBaseUrl(source, tag)}/manifest.json`;
}

// ============================================================================
// faster-whisper 单自包含运行时：内嵌 PBS 解释器 + site-packages + main.py
// （旧的「内置基座(Layer1) + 可重定位引擎包(Layer2)」两层已塌缩为一个可下载运行时；
//   不再有可单独下载/内置的 Python 基座。）
// ============================================================================

const DEFAULT_ENGINE_ID: PyEngineId = 'faster-whisper';

/**
 * 运行时内嵌 python 解释器路径（PBS 布局，按平台）：
 * win=<runtime>\python.exe，unix=<runtime>/bin/python3。
 */
export function getRuntimePythonPath(runtimeDir: string): string {
  return process.platform === 'win32'
    ? path.join(runtimeDir, 'python.exe')
    : path.join(runtimeDir, 'bin', 'python3');
}

/** 所有引擎运行时的根目录：userData/py-engines */
export function getPyEnginesRoot(): string {
  return path.join(app.getPath('userData'), 'py-engines');
}

/** 单个引擎运行时目录：userData/py-engines/<engineId> */
export function getEngineDir(engineId: PyEngineId = DEFAULT_ENGINE_ID): string {
  return path.join(getPyEnginesRoot(), engineId);
}

/** 运行时 site-packages（spawn 内嵌 python 时挂到 PYTHONPATH） */
export function getEngineSitePackages(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return path.join(getEngineDir(engineId), 'site-packages');
}

/** 运行时入口 main.py */
export function getEngineMainPy(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return path.join(getEngineDir(engineId), 'main.py');
}

/**
 * 运行时就绪 = 内嵌解释器 + main.py + site-packages 三者俱在。
 * 自包含运行时不依赖任何外部基座，故内嵌解释器存在与否是关键判据。
 */
export function isRuntimeInstalled(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): boolean {
  return (
    fs.existsSync(getRuntimePythonPath(getEngineDir(engineId))) &&
    fs.existsSync(getEngineMainPy(engineId)) &&
    fs.existsSync(getEngineSitePackages(engineId))
  );
}

export function getEngineManifestPath(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return path.join(getEngineDir(engineId), 'manifest.json');
}

export function readEngineManifest(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): PyEngineManifest | null {
  const p = getEngineManifestPath(engineId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as PyEngineManifest;
  } catch {
    return null;
  }
}

export function writeEngineManifest(
  manifest: PyEngineManifest,
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): void {
  const dir = getEngineDir(engineId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getEngineManifestPath(engineId),
    JSON.stringify(manifest, null, 2),
  );
}

/** 已安装变体：读本地 manifest.variant，缺失（老安装/未装）按 'cpu' 兜底。 */
export function getInstalledVariant(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): PyEngineVariant {
  return normalizePyEngineVariant(readEngineManifest(engineId)?.variant);
}

/**
 * 运行时产物名：smartsub-faster-whisper-runtime-<suffix>[-cuda].tar.gz（与引擎仓 release.yml 一致）。
 * cpu 变体不带后缀（即原产物名，保证向后兼容）；cuda 变体追加 -cuda。
 */
export function getEngineArtifactName(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
  variant: PyEngineVariant = 'cpu',
): string {
  const variantSuffix =
    normalizePyEngineVariant(variant) === 'cuda' ? '-cuda' : '';
  return `smartsub-${engineId}-runtime-${getPyEngineArtifactSuffix()}${variantSuffix}.tar.gz`;
}

export function getEngineDownloadUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
  variant: PyEngineVariant = 'cpu',
  tag: string = PY_ENGINE_TAG,
): string {
  return `${getPyEngineReleaseBaseUrl(source, tag)}/${getEngineArtifactName(engineId, variant)}`;
}
