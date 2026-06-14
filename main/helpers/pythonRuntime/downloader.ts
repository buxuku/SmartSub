import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as tar from 'tar';
import { logMessage } from '../storeManager';
import { calculateFileChecksum } from '../addonDownloader';
import type {
  PyEngineDownloadProgress,
  PyEngineDownloadSource,
  PyEngineManifest,
  PyEngineUpdateInfo,
  RemoteEngineManifest,
} from '../../../types/engine';
import {
  PY_ENGINE_TAG,
  getPyEngineRoot,
  getPyEngineCurrentDir,
  getPyEngineBinaryName,
  getPyEngineArtifactSuffix,
  getPyEngineDownloadUrl,
  getPyEngineChecksumsUrl,
  getPyEngineManifestUrl,
  normalizePyEngineLayout,
  writePyEngineManifest,
  readPyEngineManifest,
  deletePyEngineManifest,
  isPyEngineInstalled,
} from './paths';
import { getPythonRuntimeManager, shutdownPythonRuntime } from './index';
import { PythonEngineError } from './manager';
import { isRemoteProtocolInstallable } from './protocolSupport';
import { getSourceFallbackOrder } from '../downloadSourceOrder';
import { MirrorDownloader } from '../download/mirrorDownloader';

interface PyEngineDownloadState {
  url: string;
  destPath: string;
  tempPath: string;
  downloaded: number;
  total: number;
  tag: string;
  source: PyEngineDownloadSource;
  startedAt: string;
  lastUpdatedAt: string;
}

function getDownloadStatePath(): string {
  return path.join(app.getPath('userData'), 'py-engine-download-state.json');
}

function getPyEngineDownloadsDir(): string {
  return path.join(getPyEngineRoot(), 'downloads');
}

function getPyEngineStagingDir(): string {
  return path.join(getPyEngineRoot(), 'staging');
}

/** 升级时旧版本备份目录，自检通过后删除，失败时回滚。 */
function getPyEnginePreviousDir(): string {
  return path.join(getPyEngineRoot(), 'previous');
}

function getTempTarPath(): string {
  return path.join(getPyEngineDownloadsDir(), 'temp.tar.gz');
}

function getArtifactFileName(): string {
  return `smartsub-engine-${getPyEngineArtifactSuffix()}.tar.gz`;
}

function parseExpectedChecksum(
  checksumsContent: string,
  artifactName: string,
): string | null {
  for (const line of checksumsContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?\s*(.+)$/);
    if (match && match[2].trim() === artifactName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

export function readDownloadState(): PyEngineDownloadState | null {
  try {
    const statePath = getDownloadStatePath();
    if (fs.existsSync(statePath)) {
      return JSON.parse(
        fs.readFileSync(statePath, 'utf8'),
      ) as PyEngineDownloadState;
    }
  } catch (error) {
    logMessage(`Error reading py-engine download state: ${error}`, 'error');
  }
  return null;
}

export function saveDownloadState(state: PyEngineDownloadState | null): void {
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
    logMessage(`Error saving py-engine download state: ${error}`, 'error');
  }
}

function fetchHttpText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const request = protocol.get(
      url,
      { headers: { 'User-Agent': 'SmartSub-Electron' } },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400
        ) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            fetchHttpText(redirectUrl).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve(Buffer.concat(chunks).toString('utf8')),
        );
        response.on('error', reject);
      },
    );

    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

export class PyEngineDownloader {
  private mainWindow: BrowserWindow | null = null;
  private core: MirrorDownloader;

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
    this.core = new MirrorDownloader((p) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(
          'py-engine-download-progress',
          p as PyEngineDownloadProgress,
        );
      }
    });
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  getProgress(): PyEngineDownloadProgress {
    return this.core.getProgress() as PyEngineDownloadProgress;
  }

  cancel(): void {
    this.core.cancel();
  }

  /**
   * 安装/升级：按所选源 + 回退顺序依次尝试。
   * 用户取消与协议不支持（protocol_unsupported）属终止类错误，不再换源。
   */
  async download(source: PyEngineDownloadSource): Promise<void> {
    return this.core.runWithFallback(
      source,
      (s) => this.downloadFromSource(s),
      (error) =>
        (error instanceof Error ? error.message : String(error)) ===
          'Download cancelled' ||
        (error instanceof PythonEngineError &&
          error.code === 'protocol_unsupported'),
      'Py-engine download',
      logMessage,
    );
  }

  private async downloadFromSource(
    source: PyEngineDownloadSource,
  ): Promise<void> {
    const resolvedTag = PY_ENGINE_TAG;
    const url = getPyEngineDownloadUrl(source, resolvedTag);
    const tempPath = getTempTarPath();
    const downloadsDir = getPyEngineDownloadsDir();

    // 安装/升级前协议区间校验：拉远端 manifest，超出 app 支持区间则拒装并提示升级 SmartSub。
    // 老 release 无 manifest.json → 放行（向后兼容）。同时复用 manifest 为本地版本戳。
    const remoteManifest = await this.fetchRemoteManifest(source, resolvedTag);
    if (!isRemoteProtocolInstallable(remoteManifest)) {
      const err = new PythonEngineError(
        'protocol_unsupported',
        `engine protocolVersion=${remoteManifest?.protocolVersion} requires a newer SmartSub`,
      );
      this.core.updateProgress({
        status: 'error',
        error: 'protocol_unsupported',
      });
      logMessage(`Py-engine install blocked: ${err.message}`, 'error');
      throw err;
    }

    fs.mkdirSync(downloadsDir, { recursive: true });

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

    try {
      const existingState = readDownloadState();
      let startByte = 0;
      let downloadedPath = tempPath;

      if (
        existingState &&
        existingState.url === url &&
        fs.existsSync(existingState.tempPath)
      ) {
        downloadedPath = existingState.tempPath;
        const stat = fs.statSync(downloadedPath);
        startByte = stat.size;

        if (existingState.total > 0 && stat.size >= existingState.total) {
          logMessage(
            'Py-engine download already complete, verifying checksum',
            'info',
          );
          this.core.updateProgress({
            downloaded: stat.size,
            total: existingState.total,
            progress: 100,
            status: 'extracting',
          });
          await this.verifyExtractAndInstall(
            downloadedPath,
            source,
            resolvedTag,
            remoteManifest,
          );
          if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
          saveDownloadState(null);
          this.core.updateProgress({ status: 'completed', progress: 100 });
          return;
        }

        this.core.updateProgress({
          downloaded: startByte,
          total: existingState.total,
        });
        logMessage(
          `Resuming py-engine download from byte ${startByte}`,
          'info',
        );
      } else if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
        logMessage(`Cleaned up old py-engine temp file: ${tempPath}`, 'info');
      }

      const startedAt = new Date().toISOString();
      downloadedPath = await this.core.downloadFile(url, tempPath, startByte, {
        onBytes: (downloaded, total) =>
          saveDownloadState({
            url,
            destPath: tempPath,
            tempPath,
            downloaded,
            total,
            tag: resolvedTag,
            source,
            startedAt,
            lastUpdatedAt: new Date().toISOString(),
          }),
      });

      this.core.updateProgress({ status: 'extracting' });
      await this.verifyExtractAndInstall(
        downloadedPath,
        source,
        resolvedTag,
        remoteManifest,
      );

      if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
      saveDownloadState(null);

      this.core.updateProgress({ status: 'completed', progress: 100 });
      logMessage('Py-engine downloaded and installed', 'info');
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (errorMessage === 'Download cancelled') {
        this.core.updateProgress({
          status: 'idle',
          error: 'Download cancelled',
        });
        throw error;
      }
      this.core.updateProgress({ status: 'error', error: errorMessage });
      logMessage(`Py-engine download error: ${errorMessage}`, 'error');
      throw error;
    }
  }

  /** 拉取远端 manifest.json；老 release 不存在时返回 null（向后兼容，不报错）。 */
  private async fetchRemoteManifest(
    source: PyEngineDownloadSource,
    tag: string = PY_ENGINE_TAG,
  ): Promise<RemoteEngineManifest | null> {
    for (const s of getSourceFallbackOrder(source)) {
      try {
        const text = await fetchHttpText(getPyEngineManifestUrl(s, tag));
        return JSON.parse(text) as RemoteEngineManifest;
      } catch (error) {
        logMessage(
          `py-engine manifest.json from ${s} unavailable: ${error}`,
          'info',
        );
      }
    }
    return null;
  }

  /**
   * 更新检测：以 checksums.sha256 中本平台产物的哈希为主信号（完全适配 rolling latest），
   * 与本地 manifest.sha256 比对。同时返回远端 manifest 供版本展示与协议判定。
   */
  async checkUpdate(
    source: PyEngineDownloadSource,
  ): Promise<PyEngineUpdateInfo> {
    const localManifest = readPyEngineManifest();
    const installed = isPyEngineInstalled();

    let remoteHash: string | null = null;
    for (const s of getSourceFallbackOrder(source)) {
      try {
        const checksumsContent = await fetchHttpText(
          getPyEngineChecksumsUrl(s),
        );
        remoteHash = parseExpectedChecksum(
          checksumsContent,
          getArtifactFileName(),
        );
        if (remoteHash) break;
      } catch (error) {
        logMessage(
          `checkUpdate: fetch checksums from ${s} failed: ${error}`,
          'warning',
        );
      }
    }

    const remoteManifest = await this.fetchRemoteManifest(source);
    const protocolSupported = isRemoteProtocolInstallable(remoteManifest);

    const hasUpdate = !!(
      remoteHash &&
      localManifest?.sha256 &&
      remoteHash.toLowerCase() !== localManifest.sha256.toLowerCase()
    );

    return {
      installed,
      hasUpdate,
      localManifest,
      remoteManifest,
      remoteHash,
      protocolSupported,
    };
  }

  private buildLocalManifest(
    sha256: string,
    remoteManifest: RemoteEngineManifest | null,
  ): PyEngineManifest {
    return {
      version: remoteManifest?.engineVersion ?? PY_ENGINE_TAG,
      platform: getPyEngineArtifactSuffix(),
      sha256,
      installedAt: new Date().toISOString(),
      engineVersion: remoteManifest?.engineVersion,
      protocolVersion: remoteManifest?.protocolVersion,
      builtAt: remoteManifest?.builtAt,
      gitSha: remoteManifest?.gitSha,
    };
  }

  private async verifyExtractAndInstall(
    tarPath: string,
    source: PyEngineDownloadSource,
    tag: string,
    remoteManifest: RemoteEngineManifest | null,
  ): Promise<void> {
    const artifactName = getArtifactFileName();
    const checksumsUrl = getPyEngineChecksumsUrl(source, tag);
    const checksumsContent = await fetchHttpText(checksumsUrl);
    const expectedChecksum = parseExpectedChecksum(
      checksumsContent,
      artifactName,
    );

    if (!expectedChecksum) {
      throw new Error(
        `Checksum for ${artifactName} not found in release checksums`,
      );
    }

    const actualChecksum = await calculateFileChecksum(tarPath);
    if (actualChecksum.toLowerCase() !== expectedChecksum) {
      throw new Error(
        `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
      );
    }

    const stagingDir = getPyEngineStagingDir();
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stagingDir, { recursive: true });

    await tar.extract({
      file: tarPath,
      cwd: stagingDir,
    });

    normalizePyEngineLayout(stagingDir);
    const stagingBinary = path.join(stagingDir, getPyEngineBinaryName());
    if (!fs.existsSync(stagingBinary) || !fs.statSync(stagingBinary).isFile()) {
      throw new Error(
        `Engine binary ${getPyEngineBinaryName()} not found after extraction`,
      );
    }

    await this.installFromStaging(stagingDir, expectedChecksum, remoteManifest);
  }

  /**
   * 安全替换：先停机解锁（依赖 Phase 0 无孤儿进程）→ 备份 current→previous → swap →
   * 写 manifest → ping 自检；自检失败回滚旧版，成功删除备份。
   */
  private async installFromStaging(
    stagingDir: string,
    sha256: string,
    remoteManifest: RemoteEngineManifest | null,
  ): Promise<void> {
    const currentDir = getPyEngineCurrentDir();
    const previousDir = getPyEnginePreviousDir();
    const hadPrevious = fs.existsSync(currentDir);
    const prevManifest = readPyEngineManifest();

    // 1. 停机解 Windows 文件锁
    await shutdownPythonRuntime();

    // 2. 备份 current → previous（previous 残留先清）
    if (fs.existsSync(previousDir)) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
    if (hadPrevious) {
      fs.renameSync(currentDir, previousDir);
    }

    // 3. swap staging → current（失败立即还原备份）
    try {
      fs.renameSync(stagingDir, currentDir);
    } catch (swapError) {
      if (
        hadPrevious &&
        !fs.existsSync(currentDir) &&
        fs.existsSync(previousDir)
      ) {
        fs.renameSync(previousDir, currentDir);
      }
      throw swapError;
    }
    normalizePyEngineLayout(currentDir);

    // 4. 写新 manifest（含 engineVersion/protocolVersion/builtAt/gitSha）
    writePyEngineManifest(this.buildLocalManifest(sha256, remoteManifest));

    // 5. 自检：启动 + ping（ensureStarted 内含协议区间校验）
    try {
      this.core.updateProgress({ status: 'verifying' });
      await getPythonRuntimeManager().ensureStarted();
    } catch (selfCheckError) {
      logMessage(
        `Py-engine self-check failed, rolling back: ${selfCheckError}`,
        'error',
      );
      await this.rollback(hadPrevious, prevManifest);
      throw selfCheckError;
    }

    // 6. 成功：删除备份
    if (fs.existsSync(previousDir)) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
    logMessage('Py-engine installed and self-check passed', 'info');
  }

  private async rollback(
    hadPrevious: boolean,
    prevManifest: PyEngineManifest | null,
  ): Promise<void> {
    const currentDir = getPyEngineCurrentDir();
    const previousDir = getPyEnginePreviousDir();

    // 先停机，释放刚失败的 current/ 句柄
    await shutdownPythonRuntime();

    if (fs.existsSync(currentDir)) {
      fs.rmSync(currentDir, { recursive: true, force: true });
    }

    if (hadPrevious && fs.existsSync(previousDir)) {
      fs.renameSync(previousDir, currentDir);
      if (prevManifest) {
        writePyEngineManifest(prevManifest);
      } else {
        deletePyEngineManifest();
      }
      try {
        await getPythonRuntimeManager().ensureStarted();
        logMessage('Py-engine rolled back to previous version', 'info');
      } catch (restartError) {
        logMessage(
          `Py-engine rollback restart failed: ${restartError}`,
          'error',
        );
      }
    } else {
      // 无旧版可退（首次安装失败）：清理残留 manifest，回到未安装态
      deletePyEngineManifest();
    }
  }
}

let downloaderInstance: PyEngineDownloader | null = null;

export function getPyEngineDownloader(
  mainWindow?: BrowserWindow,
): PyEngineDownloader {
  if (!downloaderInstance) {
    downloaderInstance = new PyEngineDownloader(mainWindow);
  } else if (mainWindow) {
    downloaderInstance.setMainWindow(mainWindow);
  }
  return downloaderInstance;
}
