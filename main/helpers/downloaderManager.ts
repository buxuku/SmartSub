import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { createHash } from 'crypto';
import { logMessage } from './storeManager';
import { MirrorDownloader } from './download/mirrorDownloader';
import { prepareDownloadTarget } from './download/resumeIntegrity';
import { resolveReleaseBaseUrl } from './download/sources';
import { compareDateVersion } from './download/versionCompare';
import type { BinaryDownloadSource } from './downloadSourceOrder';
import { getSourceFallbackOrder } from './downloadSourceOrder';
import type {
  DownloaderEngine,
  DownloaderVersionsManifest,
  DownloaderEngineManifest,
  DownloaderAssetInfo,
  DownloaderStatus,
  DownloaderInstallProgress,
  InstalledDownloaderInfo,
} from '../../types/download';
import { DOWNLOADER_ENGINES } from '../../types/download';

/**
 * 下载器分发仓（rolling release `latest`）：CI 汇集 yt-dlp 官方产物与自编译 lux，
 * 连同 downloader-versions.json 一起发布；GitCode 侧为国内镜像（同步脚本见
 * scripts/sync-gitcode.sh --target downloaders）。
 */
const DOWNLOADER_REPO_SLUGS = {
  github: 'buxuku/smartsub-downloaders',
  gitcode: 'buxuku1/smartsub-downloaders',
};

const RELEASE_TAG = 'latest';
const MANIFEST_NAME = 'downloader-versions.json';
const CACHE_TTL = 5 * 60 * 1000;

/** 各引擎保留的历史版本目录数（当前版本之外） */
const KEEP_PREVIOUS_VERSIONS = 1;

interface DownloadersConfig {
  engines: Partial<
    Record<
      DownloaderEngine,
      { version: string; binaryName: string; installedAt: string }
    >
  >;
}

let cachedManifest: DownloaderVersionsManifest | null = null;
let lastFetchTime = 0;

/** 每个引擎一个安装会话（MirrorDownloader 持有 abort），避免并发安装互踩 */
const activeInstalls = new Map<DownloaderEngine, MirrorDownloader>();

export function getDownloadersDir(): string {
  return path.join(app.getPath('userData'), 'downloaders');
}

function getConfigPath(): string {
  return path.join(getDownloadersDir(), 'config.json');
}

function readConfig(): DownloadersConfig {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (error) {
    logMessage(`Error reading downloaders config: ${error}`, 'error');
  }
  return { engines: {} };
}

function saveConfig(config: DownloadersConfig): void {
  try {
    fs.mkdirSync(getDownloadersDir(), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
  } catch (error) {
    logMessage(`Error saving downloaders config: ${error}`, 'error');
  }
}

function getEngineDir(engine: DownloaderEngine): string {
  return path.join(getDownloadersDir(), engine);
}

function getVersionDir(engine: DownloaderEngine, version: string): string {
  return path.join(getEngineDir(engine), version);
}

/** 当前平台在清单 assets 中的键（不参与 CUDA 平台模拟，取真实平台） */
export function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function manifestUrl(source: BinaryDownloadSource): string {
  const base = resolveReleaseBaseUrl(
    source,
    DOWNLOADER_REPO_SLUGS,
    RELEASE_TAG,
  );
  return `${base}/${MANIFEST_NAME}`;
}

function assetUrl(source: BinaryDownloadSource, assetName: string): string {
  const base = resolveReleaseBaseUrl(
    source,
    DOWNLOADER_REPO_SLUGS,
    RELEASE_TAG,
  );
  return `${base}/${assetName}`;
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const request = protocol.get(
      url,
      {
        headers: {
          'User-Agent': 'SmartSub-Electron',
          Accept: 'application/json',
        },
        timeout: 10000,
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          fetchJson(response.headers.location).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON response'));
          }
        });
      },
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/** 拉取版本清单（5 分钟缓存 + 按所选源回退） */
export async function fetchDownloaderManifest(
  source: BinaryDownloadSource = 'github',
  force = false,
): Promise<DownloaderVersionsManifest | null> {
  if (!force && cachedManifest && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedManifest;
  }
  for (const s of getSourceFallbackOrder(source)) {
    try {
      const content = (await fetchJson(
        manifestUrl(s),
      )) as DownloaderVersionsManifest;
      if (!content?.engines) throw new Error('manifest missing engines field');
      cachedManifest = content;
      lastFetchTime = Date.now();
      logMessage(`Fetched downloader manifest from ${s}`, 'info');
      return cachedManifest;
    } catch (error) {
      logMessage(
        `Fetch downloader manifest from ${s} failed: ${error}`,
        'warning',
      );
    }
  }
  return null;
}

export function clearDownloaderManifestCache(): void {
  cachedManifest = null;
  lastFetchTime = 0;
}

/** 已安装信息（校验二进制文件真实存在，config 悬空时视为未安装） */
export function getInstalledDownloader(
  engine: DownloaderEngine,
): InstalledDownloaderInfo | null {
  const record = readConfig().engines[engine];
  if (!record) return null;
  const binaryPath = path.join(
    getVersionDir(engine, record.version),
    record.binaryName,
  );
  if (!fs.existsSync(binaryPath)) return null;
  return { engine, version: record.version, binaryPath };
}

export function getInstalledEngines(): DownloaderEngine[] {
  return DOWNLOADER_ENGINES.filter((e) => getInstalledDownloader(e) !== null);
}

/** 引擎二进制路径（未安装返回 null）；下载执行器 spawn 用 */
export function getDownloaderBinaryPath(
  engine: DownloaderEngine,
): string | null {
  return getInstalledDownloader(engine)?.binaryPath ?? null;
}

/**
 * 各引擎安装/更新状态。fetchRemote=false 时只读本地（页面首屏快速渲染），
 * 远端版本取缓存内清单（可能为 null）。
 */
export async function getDownloaderStatuses(
  source: BinaryDownloadSource = 'github',
  fetchRemote = true,
): Promise<DownloaderStatus[]> {
  const manifest = fetchRemote
    ? await fetchDownloaderManifest(source)
    : cachedManifest;
  return DOWNLOADER_ENGINES.map((engine) => {
    const installed = getInstalledDownloader(engine);
    const remote = manifest?.engines?.[engine] ?? null;
    const latestVersion = remote?.version ?? null;
    const hasUpdate = Boolean(
      installed &&
        latestVersion &&
        compareDateVersion(latestVersion, installed.version) > 0,
    );
    return { engine, installed, latestVersion, hasUpdate };
  });
}

function resolveAsset(
  engineManifest: DownloaderEngineManifest,
): DownloaderAssetInfo {
  const asset = engineManifest.assets?.[getPlatformKey()];
  if (!asset) {
    throw new Error(
      `No downloader asset for platform ${getPlatformKey()} (version ${engineManifest.version})`,
    );
  }
  return asset;
}

async function sha256Of(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 清理该引擎多余的历史版本目录（保留当前 + KEEP_PREVIOUS_VERSIONS 个最近的） */
function cleanupOldVersions(
  engine: DownloaderEngine,
  currentVersion: string,
): void {
  try {
    const engineDir = getEngineDir(engine);
    if (!fs.existsSync(engineDir)) return;
    const versions = fs
      .readdirSync(engineDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== currentVersion)
      .map((d) => d.name)
      .sort((a, b) => compareDateVersion(b, a));
    for (const version of versions.slice(KEEP_PREVIOUS_VERSIONS)) {
      fs.rmSync(path.join(engineDir, version), {
        recursive: true,
        force: true,
      });
      logMessage(`Removed old ${engine} version dir: ${version}`, 'info');
    }
  } catch (error) {
    logMessage(`cleanupOldVersions(${engine}) failed: ${error}`, 'warning');
  }
}

/**
 * 安装/更新一个下载器引擎：清单解析 → 镜像回退下载（断点续传）→ SHA256 校验 →
 * chmod → 原子落位版本目录 → 更新 config（旧版本目录保留一份回退）。
 * 进度经 onProgress 回调外抛（IPC 层负责广播节流）。
 */
export async function installDownloader(
  engine: DownloaderEngine,
  source: BinaryDownloadSource = 'github',
  onProgress?: (p: DownloaderInstallProgress) => void,
): Promise<InstalledDownloaderInfo> {
  if (activeInstalls.has(engine)) {
    throw new Error(`${engine} install already in progress`);
  }

  const manifest = await fetchDownloaderManifest(source);
  const engineManifest = manifest?.engines?.[engine];
  if (!engineManifest) {
    throw new Error(`Downloader manifest unavailable for ${engine}`);
  }
  const asset = resolveAsset(engineManifest);
  const version = engineManifest.version;

  const installed = getInstalledDownloader(engine);
  if (installed && installed.version === version) {
    onProgress?.({ engine, phase: 'completed', progress: 100 });
    return installed;
  }

  const versionDir = getVersionDir(engine, version);
  fs.mkdirSync(versionDir, { recursive: true });
  const finalPath = path.join(versionDir, asset.name);
  const tempPath = `${finalPath}.download`;

  const mirror = new MirrorDownloader((p) => {
    if (p.status === 'downloading') {
      onProgress?.({
        engine,
        phase: 'downloading',
        progress: Math.min(p.progress, 100),
      });
    }
  });
  activeInstalls.set(engine, mirror);

  try {
    // 断点续传整理：清单声明了 size 时才能安全续传，否则从零开始
    let startByte = 0;
    let alreadyComplete = false;
    if (asset.size && asset.size > 0) {
      const prepared = prepareDownloadTarget(finalPath, tempPath, asset.size);
      alreadyComplete = prepared.complete;
      startByte = prepared.startByte;
    } else if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }

    if (!alreadyComplete) {
      await mirror.runWithFallback(
        source,
        async (s) => {
          mirror.resetForDownload();
          await mirror.downloadFile(
            assetUrl(s, asset.name),
            tempPath,
            startByte,
          );
        },
        (e) => e instanceof Error && e.message === 'Download cancelled',
        `download ${engine}`,
        (msg, level) => logMessage(msg, level),
      );
    }

    onProgress?.({ engine, phase: 'verifying', progress: 100 });
    const targetForVerify = alreadyComplete ? finalPath : tempPath;
    const actualSha = await sha256Of(targetForVerify);
    if (asset.sha256 && actualSha !== asset.sha256.toLowerCase()) {
      fs.rmSync(targetForVerify, { force: true });
      throw new Error(
        `${engine} checksum mismatch: got ${actualSha}, expected ${asset.sha256}`,
      );
    }

    if (!alreadyComplete) {
      fs.renameSync(tempPath, finalPath);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(finalPath, 0o755);
    }

    const config = readConfig();
    config.engines[engine] = {
      version,
      binaryName: asset.name,
      installedAt: new Date().toISOString(),
    };
    saveConfig(config);
    cleanupOldVersions(engine, version);

    logMessage(`Installed downloader ${engine} ${version}`, 'info');
    onProgress?.({ engine, phase: 'completed', progress: 100 });
    return { engine, version, binaryPath: finalPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.({ engine, phase: 'error', progress: 0, error: message });
    throw error;
  } finally {
    activeInstalls.delete(engine);
  }
}

export function cancelDownloaderInstall(engine: DownloaderEngine): void {
  activeInstalls.get(engine)?.cancel();
}

export function isDownloaderInstallActive(engine: DownloaderEngine): boolean {
  return activeInstalls.has(engine);
}
