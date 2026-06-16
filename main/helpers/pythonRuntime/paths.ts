import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { PyEngineManifest, PyEngineId } from '../../../types/engine';
import { resolveReleaseBaseUrl } from '../download/sources';
import { getExtraResourcesPath } from '../utils';

/** 独立发布仓库：https://github.com/buxuku/smartsub-py-engine */
export const PY_ENGINE_REPO = 'buxuku/smartsub-py-engine';

/** 滚动 latest Release，SmartSub 始终从此 tag 拉取最新构建 */
export const PY_ENGINE_TAG = 'latest';

export function getPyEngineRoot(): string {
  return path.join(app.getPath('userData'), 'py-engine');
}

export function getPyEngineCurrentDir(): string {
  return path.join(getPyEngineRoot(), 'current');
}

export function getPyEngineBinaryName(): string {
  return process.platform === 'win32'
    ? 'smartsub-engine.exe'
    : 'smartsub-engine';
}

export function getPyEngineBinaryPath(): string {
  return path.join(getPyEngineCurrentDir(), getPyEngineBinaryName());
}

/** 解压后确保主二进制可执行（Unix）；Windows 跳过 */
export function ensurePyEngineExecutable(binaryPath: string): void {
  if (process.platform === 'win32') return;
  if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) return;
  try {
    fs.chmodSync(binaryPath, 0o755);
  } catch {
    // 权限不足时由 spawn 报错
  }
}

/**
 * PyInstaller onedir 的 tar 常含 smartsub-engine/ 子目录。
 * 若入口路径是目录而非文件，将子目录内容上移并修复历史错误安装。
 */
export function normalizePyEngineLayout(
  rootDir: string = getPyEngineCurrentDir(),
): void {
  const binaryName = getPyEngineBinaryName();
  const targetBinary = path.join(rootDir, binaryName);

  if (!fs.existsSync(rootDir)) return;

  const isBinaryFile = (p: string) =>
    fs.existsSync(p) && fs.statSync(p).isFile();

  if (isBinaryFile(targetBinary)) {
    ensurePyEngineExecutable(targetBinary);
    return;
  }

  // 错误布局: root/smartsub-engine/ 是目录，真实二进制在其子路径
  let containerDir: string | null = null;
  if (fs.existsSync(targetBinary) && fs.statSync(targetBinary).isDirectory()) {
    containerDir = targetBinary;
  } else {
    for (const entry of fs.readdirSync(rootDir)) {
      const entryPath = path.join(rootDir, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      if (isBinaryFile(path.join(entryPath, binaryName))) {
        containerDir = entryPath;
        break;
      }
    }
  }

  if (!containerDir) return;

  const innerBinary = path.join(containerDir, binaryName);
  const tempBinary = path.join(rootDir, `.${binaryName}.tmp`);

  // 先移出内层二进制，避免 dest 与 containerDir 同名时 rmSync 删掉整个容器
  if (isBinaryFile(innerBinary)) {
    if (fs.existsSync(tempBinary)) {
      fs.rmSync(tempBinary, { force: true });
    }
    fs.renameSync(innerBinary, tempBinary);
  }

  for (const file of fs.readdirSync(containerDir)) {
    const src = path.join(containerDir, file);
    const dest = path.join(rootDir, file);
    if (dest === containerDir) continue;
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.renameSync(src, dest);
  }

  try {
    const remaining = fs.readdirSync(containerDir);
    if (remaining.length === 0) {
      fs.rmdirSync(containerDir);
    } else {
      fs.rmSync(containerDir, { recursive: true, force: true });
    }
  } catch {
    // 容器可能已被移空
  }

  if (fs.existsSync(tempBinary)) {
    if (fs.existsSync(targetBinary)) {
      fs.rmSync(targetBinary, { recursive: true, force: true });
    }
    fs.renameSync(tempBinary, targetBinary);
  }

  if (isBinaryFile(targetBinary)) {
    ensurePyEngineExecutable(targetBinary);
  }
}

export function getPyEngineCacheDir(): string {
  return path.join(app.getPath('userData'), 'py-engine-cache');
}

export function isPyEngineInstalled(): boolean {
  normalizePyEngineLayout();
  const binaryPath = getPyEngineBinaryPath();
  try {
    if (!fs.statSync(binaryPath).isFile()) return false;
    if (process.platform !== 'win32') {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function readPyEngineManifest(): PyEngineManifest | null {
  const manifestPath = path.join(getPyEngineRoot(), 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as PyEngineManifest;
  } catch {
    return null;
  }
}

export function writePyEngineManifest(manifest: PyEngineManifest): void {
  const root = getPyEngineRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
}

export function deletePyEngineManifest(): void {
  const manifestPath = path.join(getPyEngineRoot(), 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    fs.rmSync(manifestPath, { force: true });
  }
}

export function getPyEngineArtifactSuffix(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'linux') return 'linux-x64';
  throw new Error(`Unsupported platform: ${process.platform}`);
}

/** GitCode 镜像 owner 与 GitHub 不同（buxuku1），repo 名相同。 */
const PY_ENGINE_REPO_SLUGS = {
  github: PY_ENGINE_REPO,
  gitcode: 'buxuku1/smartsub-py-engine',
};

function getPyEngineReleaseBaseUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  return resolveReleaseBaseUrl(source, PY_ENGINE_REPO_SLUGS, tag);
}

export function getPyEngineDownloadUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  const asset = `smartsub-engine-${getPyEngineArtifactSuffix()}.tar.gz`;
  return `${getPyEngineReleaseBaseUrl(source, tag)}/${asset}`;
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
// 三层架构：Python 基座（Layer 1）+ 可重定位引擎包（Layer 2）路径解析
// ============================================================================

const DEFAULT_ENGINE_ID: PyEngineId = 'faster-whisper';

/** 基座 python 解释器路径（按平台）：win=<base>\python.exe，unix=<base>/bin/python3 */
export function getPyBasePythonPath(baseDir: string): string {
  return process.platform === 'win32'
    ? path.join(baseDir, 'python.exe')
    : path.join(baseDir, 'bin', 'python3');
}

/** 内置基座目录（随安装包按平台打进 extraResources） */
export function getBuiltinPyBaseDir(): string {
  return path.join(getExtraResourcesPath(), 'py-base');
}

/** 可升级覆盖基座目录（userData，存在则优先于内置） */
export function getUserPyBaseDir(): string {
  return path.join(app.getPath('userData'), 'py-base', 'current');
}

/** 解析当前生效基座目录：userData 覆盖优先，回退内置 */
export function resolvePyBaseDir(): string {
  const userDir = getUserPyBaseDir();
  if (fs.existsSync(getPyBasePythonPath(userDir))) return userDir;
  return getBuiltinPyBaseDir();
}

/** 基座是否就绪（解释器存在） */
export function isPyBaseReady(): boolean {
  return fs.existsSync(getPyBasePythonPath(resolvePyBaseDir()));
}

/** 所有引擎包的根目录：userData/py-engines */
export function getPyEnginesRoot(): string {
  return path.join(app.getPath('userData'), 'py-engines');
}

/** 单个引擎包目录：userData/py-engines/<engineId> */
export function getEngineDir(engineId: PyEngineId = DEFAULT_ENGINE_ID): string {
  return path.join(getPyEnginesRoot(), engineId);
}

/** 引擎包的 site-packages（spawn 基座 python 时挂到 PYTHONPATH） */
export function getEngineSitePackages(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return path.join(getEngineDir(engineId), 'site-packages');
}

/** 引擎包入口 main.py */
export function getEngineMainPy(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return path.join(getEngineDir(engineId), 'main.py');
}

/** 引擎包就绪 = main.py + site-packages 同时存在（取代旧的单二进制判定） */
export function isEnginePackageInstalled(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): boolean {
  return (
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

/** 引擎包产物名：smartsub-<engineId>-<suffix>.tar.gz */
export function getEngineArtifactName(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return `smartsub-${engineId}-${getPyEngineArtifactSuffix()}.tar.gz`;
}

export function getEngineDownloadUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
  tag: string = PY_ENGINE_TAG,
): string {
  return `${getPyEngineReleaseBaseUrl(source, tag)}/${getEngineArtifactName(engineId)}`;
}
