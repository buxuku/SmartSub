import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as tar from 'tar';
import { pipeline } from 'stream/promises';
import { logMessage } from './storeManager';
import type {
  DownloadProgress,
  DownloadState,
  DownloadSource,
  AddonVariant,
  AddonDownloadResult,
  AddonInstallProvenance,
  RemoteAddonVersions,
} from '../../types/addon';
import { getEffectivePlatform } from './cudaUtils';
import { getAddonVersionDir } from './addonManager';
import { createHash } from 'crypto';
import { resolveReleaseBaseUrl } from './download/sources';
import { MirrorDownloader } from './download/mirrorDownloader';
import { fetchJson } from './download/fetchJson';
import { commitStagedDirectory } from './download/atomicDirectoryInstall';

/**
 * 加速包发布仓库（注意：GitCode 镜像用的是 whisper.node 仓库，与 GitHub 不同）。
 */
const ADDON_REPO_SLUGS = {
  github: 'buxuku/whisper.cpp',
  gitcode: 'buxuku1/whisper.node',
};

/** addon release 基础 URL（保留末尾斜杠，兼容旧的拼接方式）。 */
function addonBaseUrl(source: DownloadSource): string {
  return `${resolveReleaseBaseUrl(source, ADDON_REPO_SLUGS, 'latest')}/`;
}

/** Provenance is also exported in diagnostics; endpoint credentials stay local. */
function provenanceUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

/** addon-versions.json 的下载地址（按源） */
export function getAddonVersionsUrl(source: DownloadSource): string {
  return `${addonBaseUrl(source)}addon-versions.json`;
}

/**
 * 获取下载状态文件路径
 */
function getDownloadStatePath(): string {
  return path.join(app.getPath('userData'), 'addon-download-state.json');
}

/**
 * 读取下载状态
 */
export function readDownloadState(): DownloadState | null {
  try {
    const statePath = getDownloadStatePath();
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(content);
      // 兼容旧版字段名 cudaVersion（v2.16 之前的断点续传状态文件）
      if (parsed && parsed.cudaVersion && !parsed.variant) {
        parsed.variant = parsed.cudaVersion;
        delete parsed.cudaVersion;
      }
      return parsed;
    }
  } catch (error) {
    logMessage(`Error reading download state: ${error}`, 'error');
  }
  return null;
}

/**
 * 保存下载状态
 */
function saveDownloadState(state: DownloadState | null): void {
  try {
    const statePath = getDownloadStatePath();
    if (state === null) {
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
      }
    } else {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  } catch (error) {
    logMessage(`Error saving download state: ${error}`, 'error');
  }
}

/**
 * 获取加速包文件名
 */
export function getAddonFileName(
  variant: AddonVariant,
  downloadType: 'node.gz' | 'tar.gz',
): string {
  const platform = getEffectivePlatform();
  if (platform !== 'win32' && platform !== 'linux') {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const osName = platform === 'win32' ? 'windows' : 'linux';

  if (variant === 'vulkan') {
    // Vulkan 无运行时依赖，仅提供 node.gz 单文件包
    if (downloadType === 'tar.gz') {
      throw new Error('Vulkan addon only provides node.gz package');
    }
    return `addon-${osName}-vulkan.node.gz`;
  }

  const versionNum = variant.replace(/\./g, '').slice(0, 4);
  return downloadType === 'tar.gz'
    ? `${osName}-cuda-${versionNum}-optimized.tar.gz`
    : `addon-${osName}-cuda-${versionNum}-optimized.node.gz`;
}

/**
 * 获取完整下载 URL
 */
export function getDownloadUrl(
  source: DownloadSource,
  variant: AddonVariant,
  downloadType: 'node.gz' | 'tar.gz',
): string {
  const baseUrl = addonBaseUrl(source);
  const fileName = getAddonFileName(variant, downloadType);
  return `${baseUrl}${fileName}`;
}

/**
 * 加速包下载器类
 */
export class AddonDownloader {
  private mainWindow: BrowserWindow | null = null;
  private core: MirrorDownloader;
  private operation: AbortController | null = null;

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
    this.core = new MirrorDownloader((p) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(
          'addon-download-progress',
          p as DownloadProgress,
        );
      }
    });
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  getProgress(): DownloadProgress {
    return this.core.getProgress() as DownloadProgress;
  }

  cancel(): void {
    this.operation?.abort();
    this.core.cancel();
  }

  /**
   * 执行下载：按所选源 + 回退顺序依次尝试，任一源成功即返回。
   * 用户取消（Download cancelled）不回退，直接抛出。
   */
  download(
    source: DownloadSource,
    variant: AddonVariant,
    downloadType: 'node.gz' | 'tar.gz',
  ): Promise<AddonDownloadResult> {
    if (this.operation) throw new Error('An addon download is already running');
    const operation = new AbortController();
    this.operation = operation;
    // Reject a busy start synchronously so IPC can report that it never started.
    return this.core
      .runWithFallback(
        source,
        (s) =>
          this.downloadFromSource(s, variant, downloadType, operation.signal),
        () => operation.signal.aborted,
        'Addon download',
        logMessage,
      )
      .catch((error: unknown) => {
        const message = operation.signal.aborted
          ? 'Download cancelled'
          : error instanceof Error
            ? error.message
            : String(error);
        this.core.updateProgress({
          status: operation.signal.aborted ? 'idle' : 'error',
          error: message,
        });
        throw new Error(message);
      })
      .finally(() => {
        this.operation = null;
      });
  }

  /**
   * 从单一源执行下载（断点续传 + 进度走共享核心；解压沿用 addon 专属逻辑）
   */
  private async downloadFromSource(
    source: DownloadSource,
    variant: AddonVariant,
    downloadType: 'node.gz' | 'tar.gz',
    signal: AbortSignal,
  ): Promise<AddonDownloadResult> {
    const url = getDownloadUrl(source, variant, downloadType);
    const manifestUrl = getAddonVersionsUrl(source);
    const addonsDir = path.join(app.getPath('userData'), 'addons');
    const versionDir = getAddonVersionDir(variant);

    fs.mkdirSync(addonsDir, { recursive: true });

    this.core.resetForDownload();
    this.core.updateProgress({
      status: 'downloading',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: 0,
      error: undefined,
    });

    let stagedDir: string | undefined;
    try {
      // Do not use the update-check cache or metadata from a different mirror.
      const manifest = await fetchJson<RemoteAddonVersions>(manifestUrl, {
        signal,
        timeoutMs: 10_000,
        headers: {
          'User-Agent': 'SmartSub-Electron',
          Accept: 'application/json',
        },
      });
      const entry = manifest?.[variant];
      const osName = getEffectivePlatform() === 'win32' ? 'windows' : 'linux';
      const checksumKey =
        `${osName}-${downloadType === 'tar.gz' ? 'tar' : 'node'}` as
          | 'windows-tar'
          | 'windows-node'
          | 'linux-tar'
          | 'linux-node';
      const checksum = entry?.checksum?.[checksumKey];
      if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(checksum)) {
        throw new Error(
          `Missing or invalid SHA-256 checksum for ${variant}/${checksumKey} from ${source}`,
        );
      }
      if (typeof entry.version !== 'string' || !entry.version.trim()) {
        throw new Error(
          `Missing addon release version for ${variant} from ${source}`,
        );
      }
      const expectedChecksum = checksum.toLowerCase();
      // Snapshot only fields belonging to this verified artifact. A separate
      // latest/build-info.json is not sufficient to identify legacy variants.
      const releaseVersion = entry.version;
      const updateNotes =
        typeof entry.updateNotes === 'string' ? entry.updateNotes : '';
      signal.throwIfAborted();
      const existingState = readDownloadState();
      let startByte = 0;
      let tempPath: string;

      if (
        existingState &&
        existingState.url === url &&
        existingState.expectedChecksum === expectedChecksum &&
        fs.existsSync(existingState.tempPath)
      ) {
        tempPath = existingState.tempPath;
        const stat = fs.statSync(tempPath);
        startByte = stat.size;

        this.core.updateProgress({
          downloaded: startByte,
          total: existingState.total,
        });
        logMessage(`Resuming download from byte ${startByte}`, 'info');
      } else {
        tempPath = path.join(addonsDir, `temp-${variant.replace(/\./g, '')}`);
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
          logMessage(`Cleaned up old temp file: ${tempPath}`, 'info');
        }
      }

      const startedAt = new Date().toISOString();
      const alreadyComplete =
        existingState?.url === url &&
        existingState.expectedChecksum === expectedChecksum &&
        existingState.total > 0 &&
        startByte >= existingState.total;
      const downloadedPath = alreadyComplete
        ? tempPath
        : await this.core.downloadFile(url, tempPath, startByte, {
            onBytes: (downloaded, total) =>
              saveDownloadState({
                url,
                expectedChecksum,
                destPath: tempPath,
                tempPath,
                downloaded,
                total,
                variant,
                downloadType,
                startedAt,
                lastUpdatedAt: new Date().toISOString(),
              }),
          });

      this.core.updateProgress({ status: 'verifying' });
      const packageSha256 = await calculateFileChecksum(downloadedPath, signal);
      if (packageSha256 !== expectedChecksum) {
        fs.rmSync(downloadedPath, { force: true });
        saveDownloadState(null);
        throw new Error(
          `Addon SHA-256 checksum mismatch from ${source}: expected ${expectedChecksum}, got ${packageSha256}`,
        );
      }
      signal.throwIfAborted();
      stagedDir = fs.mkdtempSync(path.join(addonsDir, `.${variant}-staging-`));
      this.core.updateProgress({ status: 'extracting' });
      await this.extractFile(downloadedPath, stagedDir, downloadType);
      const provenance: AddonInstallProvenance = {
        formatVersion: 1,
        source,
        packageType: downloadType,
        packageUrl: provenanceUrl(url),
        manifestUrl: provenanceUrl(manifestUrl),
        releaseVersion,
        updateNotes,
        expectedSha256: expectedChecksum,
        packageSha256,
        addonSha256: await calculateFileChecksum(
          path.join(stagedDir, 'addon.node'),
          signal,
        ),
        verifiedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stagedDir, 'addon-install.json'),
        JSON.stringify(provenance, null, 2),
      );
      signal.throwIfAborted();
      await commitStagedDirectory({
        stagedDir,
        destDir: versionDir,
        backupDir: `${stagedDir}-backup`,
        onCleanupWarning: (message) => logMessage(message, 'warning'),
      });
      // Once committed, failure to remove the download must not misreport the
      // installation as failed or trigger replacement from another mirror.
      try {
        fs.rmSync(downloadedPath, { force: true });
      } catch (error) {
        logMessage(`Failed to clean addon download: ${error}`, 'warning');
      }
      saveDownloadState(null);

      this.core.updateProgress({ status: 'completed', progress: 100 });
      logMessage(
        `Addon ${variant} verified and installed: ${JSON.stringify(provenance)}`,
        'info',
      );
      return { directory: versionDir, provenance };
    } finally {
      if (stagedDir) {
        try {
          fs.rmSync(stagedDir, { recursive: true, force: true });
        } catch (error) {
          logMessage(
            `Failed to clean addon staging directory: ${error}`,
            'warning',
          );
        }
      }
    }
  }

  /**
   * 解压文件
   */
  private async extractFile(
    filePath: string,
    destDir: string,
    downloadType: 'node.gz' | 'tar.gz',
  ): Promise<void> {
    if (downloadType === 'tar.gz') {
      await tar.extract({
        file: filePath,
        cwd: destDir,
      });

      await this.renameNodeFile(destDir);
    } else {
      const destPath = path.join(destDir, 'addon.node');
      await this.gunzipFile(filePath, destPath);
    }

    logMessage(`Extracted to ${destDir}`, 'info');
  }

  /**
   * 查找并重命名 .node 文件为 addon.node
   * 支持在根目录和一级子目录中查找
   */
  private async renameNodeFile(destDir: string): Promise<void> {
    // 首先在根目录查找
    const files = fs.readdirSync(destDir);
    logMessage(`Files in ${destDir}: ${files.join(', ')}`, 'info');

    let nodeFile = files.find((f) => f.endsWith('.node') && f !== 'addon.node');

    if (nodeFile) {
      const oldPath = path.join(destDir, nodeFile);
      const newPath = path.join(destDir, 'addon.node');

      // 如果已存在 addon.node，先删除
      if (fs.existsSync(newPath)) {
        fs.unlinkSync(newPath);
      }

      fs.renameSync(oldPath, newPath);
      logMessage(`Renamed ${nodeFile} to addon.node`, 'info');
      return;
    }

    // 如果根目录没找到，检查一级子目录（tar 可能解压到子目录）
    for (const item of files) {
      const itemPath = path.join(destDir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        const subFiles = fs.readdirSync(itemPath);
        logMessage(
          `Files in subdirectory ${item}: ${subFiles.join(', ')}`,
          'info',
        );

        // 查找 .node 文件
        nodeFile = subFiles.find(
          (f) => f.endsWith('.node') && f !== 'addon.node',
        );

        if (nodeFile) {
          // 将子目录中的所有文件移动到根目录
          for (const subFile of subFiles) {
            const srcPath = path.join(itemPath, subFile);
            const destPath = path.join(
              destDir,
              subFile === nodeFile ? 'addon.node' : subFile,
            );

            // 如果目标文件已存在，先删除
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath);
            }

            fs.renameSync(srcPath, destPath);
            logMessage(
              `Moved ${subFile} from subdirectory to ${destPath}`,
              'info',
            );
          }

          // 删除空的子目录
          fs.rmdirSync(itemPath);
          logMessage(`Removed empty subdirectory: ${item}`, 'info');
          return;
        }
      }
    }

    // 检查是否已经有 addon.node 文件
    if (files.includes('addon.node')) {
      logMessage('addon.node already exists', 'info');
      return;
    }

    throw new Error('No .node file found in extracted addon package');
  }

  /**
   * 解压 gzip 文件
   */
  private gunzipFile(srcPath: string, destPath: string): Promise<void> {
    return pipeline(
      fs.createReadStream(srcPath),
      zlib.createGunzip(),
      fs.createWriteStream(destPath),
    );
  }
}

/**
 * 计算文件的 SHA256 校验和
 */
export async function calculateFileChecksum(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath, { signal }))
    hash.update(chunk);
  return hash.digest('hex');
}

/**
 * 验证文件校验和
 */
export async function verifyChecksum(
  filePath: string,
  expectedChecksum: string,
): Promise<boolean> {
  try {
    const actualChecksum = await calculateFileChecksum(filePath);
    return actualChecksum.toLowerCase() === expectedChecksum.toLowerCase();
  } catch {
    return false;
  }
}

// 导出单例实例
let downloaderInstance: AddonDownloader | null = null;

export function getAddonDownloader(
  mainWindow?: BrowserWindow,
): AddonDownloader {
  if (!downloaderInstance) {
    downloaderInstance = new AddonDownloader(mainWindow);
  } else if (mainWindow) {
    downloaderInstance.setMainWindow(mainWindow);
  }
  return downloaderInstance;
}
