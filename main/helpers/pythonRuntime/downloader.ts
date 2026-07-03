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
import type { PyEngineId, PyEngineVariant } from '../../../types/engine';
import {
  PY_ENGINE_TAG,
  getPyEnginesRoot,
  getEngineDir,
  getEngineArtifactName,
  getEngineDownloadUrl,
  getPyEngineArtifactSuffix,
  getPyEngineChecksumsUrl,
  getPyEngineManifestUrl,
  isRuntimeInstalled,
  isRuntimeDirIntact,
  getParkedEngineDir,
  getRuntimePythonPath,
  writeEngineManifest,
  readEngineManifest,
  readEngineManifestFromDir,
  getInstalledVariant,
  normalizePyEngineVariant,
} from './paths';
import { canFastSwitchVariant, planPreviousRuntimeDisposal } from './parking';
import { adhocResignDir } from './macSign';
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

function getDownloadStatePath(engineId: PyEngineId): string {
  return path.join(
    app.getPath('userData'),
    `py-engine-download-state-${engineId}.json`,
  );
}

/** 下载/解压/备份的临时根（与各引擎包同盘，保证 rename 原子替换） */
function getPyEngineScratchRoot(): string {
  return path.join(getPyEnginesRoot(), '.cache');
}

function getPyEngineDownloadsDir(): string {
  return path.join(getPyEngineScratchRoot(), 'downloads');
}

function getPyEngineStagingDir(engineId: PyEngineId): string {
  return path.join(getPyEngineScratchRoot(), 'staging', engineId);
}

/** 升级时旧版本备份目录，自检通过后删除，失败时回滚。 */
function getPyEnginePreviousDir(engineId: PyEngineId): string {
  return path.join(getPyEngineScratchRoot(), 'previous', engineId);
}

function getTempTarPath(engineId: PyEngineId): string {
  return path.join(getPyEngineDownloadsDir(), `${engineId}.tar.gz`);
}

function getArtifactFileName(
  engineId: PyEngineId,
  variant: PyEngineVariant,
): string {
  return getEngineArtifactName(engineId, variant);
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

export function readDownloadState(
  engineId: PyEngineId,
): PyEngineDownloadState | null {
  try {
    const statePath = getDownloadStatePath(engineId);
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

export function saveDownloadState(
  state: PyEngineDownloadState | null,
  engineId: PyEngineId,
): void {
  try {
    const statePath = getDownloadStatePath(engineId);
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
  private engineId: PyEngineId;
  private mainWindow: BrowserWindow | null = null;
  private core: MirrorDownloader;

  constructor(engineId: PyEngineId, mainWindow?: BrowserWindow) {
    this.engineId = engineId;
    this.mainWindow = mainWindow || null;
    this.core = new MirrorDownloader((p) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('py-engine-download-progress', {
          ...(p as PyEngineDownloadProgress),
          engineId: this.engineId,
        });
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
   * variant 决定下载 CPU 包还是 Full GPU(CUDA) 包；不支持 cuda 的平台会收敛为 cpu。
   * 用户取消与协议不支持（protocol_unsupported）属终止类错误，不再换源。
   */
  async download(
    source: PyEngineDownloadSource,
    variant: PyEngineVariant = 'cpu',
  ): Promise<void> {
    const resolvedVariant = normalizePyEngineVariant(variant);
    // 变体切换的免下载快路径：目标变体已有完好驻留副本时目录互换即完成，
    // 秒级、零流量、可离线；副本可能落后远端 latest，由既有 checkUpdate 提示升级。
    if (await this.trySwitchToParkedVariant(resolvedVariant)) {
      return;
    }
    // 自包含运行时内嵌解释器，无外部基座依赖，可直接下载。
    return this.core.runWithFallback(
      source,
      (s) => this.downloadFromSource(s, resolvedVariant),
      (error) =>
        (error instanceof Error ? error.message : String(error)) ===
          'Download cancelled' ||
        (error instanceof PythonEngineError &&
          error.code === 'protocol_unsupported'),
      'Py-engine download',
      logMessage,
    );
  }

  /**
   * 免下载即时切换：目标变体存在完好驻留副本时，停机 → 当前运行时驻留 →
   * 副本换入 current → ensureStarted 自检。成功返回 true（调用方跳过下载）；
   * 不满足条件返回 false；自检失败则回滚原运行时后返回 false，转入正常下载。
   */
  private async trySwitchToParkedVariant(
    variant: PyEngineVariant,
  ): Promise<boolean> {
    const currentDir = getEngineDir(this.engineId);
    const parkedTargetDir = getParkedEngineDir(this.engineId, variant);
    const currentIntact = isRuntimeInstalled(this.engineId);
    const installedVariant = currentIntact
      ? getInstalledVariant(this.engineId)
      : null;

    if (
      !canFastSwitchVariant({
        targetVariant: variant,
        installedVariant,
        parkedTargetIntact: isRuntimeDirIntact(parkedTargetDir),
      })
    ) {
      return false;
    }

    logMessage(
      `Py-engine[${this.engineId}] switching to parked ${variant} runtime (no download)`,
      'info',
    );
    this.core.resetForDownload();
    this.core.updateProgress({
      status: 'verifying',
      progress: 100,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: 0,
      error: undefined,
    });

    // 停机解 Windows 文件锁后再动目录
    await shutdownPythonRuntime();

    // 当前运行时完好则驻留（供切回），破损则丢弃；随后把目标副本换入 current。
    let previousParkedDir: string | null = null;
    try {
      if (currentIntact && installedVariant) {
        previousParkedDir = getParkedEngineDir(this.engineId, installedVariant);
        if (fs.existsSync(previousParkedDir)) {
          fs.rmSync(previousParkedDir, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(previousParkedDir), { recursive: true });
        fs.renameSync(currentDir, previousParkedDir);
      } else if (fs.existsSync(currentDir)) {
        fs.rmSync(currentDir, { recursive: true, force: true });
      }
      fs.mkdirSync(path.dirname(currentDir), { recursive: true });
      fs.renameSync(parkedTargetDir, currentDir);
    } catch (swapError) {
      logMessage(
        `Py-engine fast-switch swap failed, falling back to download: ${swapError}`,
        'warning',
      );
      try {
        if (
          !fs.existsSync(currentDir) &&
          previousParkedDir &&
          fs.existsSync(previousParkedDir)
        ) {
          fs.renameSync(previousParkedDir, currentDir);
        }
      } catch (restoreError) {
        // 还原失败也无妨：随后的正常下载会重建 current
        logMessage(
          `Py-engine fast-switch restore failed: ${restoreError}`,
          'warning',
        );
      }
      return false;
    }

    // 自检：启动 + ping。失败删除坏副本、还原原运行时，转入正常下载。
    try {
      await getPythonRuntimeManager().ensureStarted(this.engineId);
    } catch (selfCheckError) {
      logMessage(
        `Py-engine parked ${variant} runtime self-check failed, falling back to download: ${selfCheckError}`,
        'warning',
      );
      await shutdownPythonRuntime();
      try {
        fs.rmSync(currentDir, { recursive: true, force: true });
        if (previousParkedDir && fs.existsSync(previousParkedDir)) {
          fs.renameSync(previousParkedDir, currentDir);
        }
      } catch (rollbackError) {
        logMessage(
          `Py-engine fast-switch rollback failed: ${rollbackError}`,
          'error',
        );
      }
      return false;
    }

    this.core.updateProgress({ status: 'completed', progress: 100 });
    logMessage(
      `Py-engine[${this.engineId}] switched to ${variant} from parked copy`,
      'info',
    );
    return true;
  }

  private async downloadFromSource(
    source: PyEngineDownloadSource,
    variant: PyEngineVariant,
  ): Promise<void> {
    const resolvedTag = PY_ENGINE_TAG;
    const url = getEngineDownloadUrl(
      source,
      this.engineId,
      variant,
      resolvedTag,
    );
    const tempPath = getTempTarPath(this.engineId);
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
      const existingState = readDownloadState(this.engineId);
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
            variant,
          );
          if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
          saveDownloadState(null, this.engineId);
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
          saveDownloadState(
            {
              url,
              destPath: tempPath,
              tempPath,
              downloaded,
              total,
              tag: resolvedTag,
              source,
              startedAt,
              lastUpdatedAt: new Date().toISOString(),
            },
            this.engineId,
          ),
      });

      this.core.updateProgress({ status: 'extracting' });
      await this.verifyExtractAndInstall(
        downloadedPath,
        source,
        resolvedTag,
        remoteManifest,
        variant,
      );

      if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
      saveDownloadState(null, this.engineId);

      this.core.updateProgress({ status: 'completed', progress: 100 });
      logMessage(
        `Py-engine[${this.engineId}] downloaded and installed`,
        'info',
      );
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
      // 两类情况必须清掉残留临时包与续传状态，避免下次一直续传同一个坏/锁文件：
      // 1) Windows 文件被锁（EPERM/EBUSY/EACCES）——否则一直打开同一被锁文件无法重下；
      // 2) 内容损坏（校验/解包失败）——续传判定只看 URL，而引擎 tag 固定为 latest，
      //    上游 latest 重发或代理忽略 Range 都会让已下载的临时包损坏；若不清理，
      //    下次重试会再次命中续传、把字节拼到坏文件后，导致 sha 反复不匹配的死循环。
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      const isCorruptArtifact =
        errorMessage.includes('Checksum mismatch') ||
        errorMessage.includes('Invalid engine package') ||
        errorMessage.includes('not found in release checksums');
      if (
        code === 'EPERM' ||
        code === 'EBUSY' ||
        code === 'EACCES' ||
        isCorruptArtifact
      ) {
        try {
          if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
        } catch (cleanupError) {
          logMessage(
            `Failed to remove py-engine temp file: ${cleanupError}`,
            'warning',
          );
        }
        saveDownloadState(null, this.engineId);
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
    variant?: PyEngineVariant,
  ): Promise<PyEngineUpdateInfo> {
    const localManifest = readEngineManifest(this.engineId);
    const installed = isRuntimeInstalled(this.engineId);
    // 未显式指定时按已安装变体检查（老安装无 variant 字段 → 'cpu' 兜底）。
    const resolvedVariant = normalizePyEngineVariant(
      variant ?? localManifest?.variant,
    );

    let remoteHash: string | null = null;
    for (const s of getSourceFallbackOrder(source)) {
      try {
        const checksumsContent = await fetchHttpText(
          getPyEngineChecksumsUrl(s),
        );
        remoteHash = parseExpectedChecksum(
          checksumsContent,
          getArtifactFileName(this.engineId, resolvedVariant),
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

    // 变体切换（已装 cpu、目标 cuda 或反之）也视为「有更新」，以驱动 UI 的下载入口；
    // 同变体则按哈希比对判断是否为内容更新。
    const installedVariant = normalizePyEngineVariant(localManifest?.variant);
    const variantSwitch = installed && installedVariant !== resolvedVariant;
    const hasUpdate =
      variantSwitch ||
      !!(
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
      variant: resolvedVariant,
    };
  }

  private buildLocalManifest(
    sha256: string,
    remoteManifest: RemoteEngineManifest | null,
    variant: PyEngineVariant,
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
      engineId: this.engineId,
      pythonAbi: remoteManifest?.pythonAbi ?? 'cp312',
      variant,
    };
  }

  private async verifyExtractAndInstall(
    tarPath: string,
    source: PyEngineDownloadSource,
    tag: string,
    remoteManifest: RemoteEngineManifest | null,
    variant: PyEngineVariant,
  ): Promise<void> {
    const artifactName = getArtifactFileName(this.engineId, variant);
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

    const stagingDir = getPyEngineStagingDir(this.engineId);
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stagingDir, { recursive: true });

    await tar.extract({
      file: tarPath,
      cwd: stagingDir,
    });

    // 自包含运行时：归档顶层即 内嵌解释器 + main.py + site-packages/（无外部基座）。
    const stagingMain = path.join(stagingDir, 'main.py');
    const stagingSite = path.join(stagingDir, 'site-packages');
    const stagingPython = getRuntimePythonPath(stagingDir);
    if (
      !fs.existsSync(stagingMain) ||
      !fs.existsSync(stagingSite) ||
      !fs.existsSync(stagingPython)
    ) {
      throw new Error(
        'Invalid runtime package: missing embedded interpreter, main.py, or site-packages after extraction',
      );
    }

    await this.installFromStaging(
      stagingDir,
      expectedChecksum,
      remoteManifest,
      variant,
    );
  }

  /**
   * 安全替换：先停机解锁（依赖 Phase 0 无孤儿进程）→ 备份 current→previous → swap →
   * 写 manifest → ping 自检；自检失败回滚旧版，成功删除备份。
   */
  private async installFromStaging(
    stagingDir: string,
    sha256: string,
    remoteManifest: RemoteEngineManifest | null,
    variant: PyEngineVariant,
  ): Promise<void> {
    const currentDir = getEngineDir(this.engineId);
    const previousDir = getPyEnginePreviousDir(this.engineId);
    const hadPrevious = fs.existsSync(currentDir);

    // 1. 停机解 Windows 文件锁
    await shutdownPythonRuntime();

    // 2. 备份 current → previous（previous 残留先清；manifest 在包目录内随之备份）
    if (fs.existsSync(previousDir)) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(previousDir), { recursive: true });
    if (hadPrevious) {
      fs.renameSync(currentDir, previousDir);
    }

    // 3. swap staging → current（失败立即还原备份）
    fs.mkdirSync(path.dirname(currentDir), { recursive: true });
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

    // 3b. macOS 无证书兜底：对换入的原生库 ad-hoc 重签
    adhocResignDir(currentDir);

    // 4. 写新 manifest（写在引擎包目录内，随目录一起 swap/rollback）
    writeEngineManifest(
      this.buildLocalManifest(sha256, remoteManifest, variant),
      this.engineId,
    );

    // 5. 自检：启动 + ping（ensureStarted 内含协议区间校验）
    try {
      this.core.updateProgress({ status: 'verifying' });
      await getPythonRuntimeManager().ensureStarted(this.engineId);
    } catch (selfCheckError) {
      logMessage(
        `Py-engine self-check failed, rolling back: ${selfCheckError}`,
        'error',
      );
      await this.rollback(hadPrevious);
      throw selfCheckError;
    }

    // 6. 成功：处置旧运行时备份——变体切换则驻留（供免下载切回），
    //    同变体升级/修复或备份破损则删除（与旧行为一致）。
    if (fs.existsSync(previousDir)) {
      const previousVariant = normalizePyEngineVariant(
        readEngineManifestFromDir(previousDir)?.variant,
      );
      const disposal = planPreviousRuntimeDisposal({
        previousVariant,
        installedVariant: variant,
        previousIntact: isRuntimeDirIntact(previousDir),
      });
      if (disposal === 'park') {
        try {
          const parkedDir = getParkedEngineDir(this.engineId, previousVariant);
          if (fs.existsSync(parkedDir)) {
            fs.rmSync(parkedDir, { recursive: true, force: true });
          }
          fs.mkdirSync(path.dirname(parkedDir), { recursive: true });
          fs.renameSync(previousDir, parkedDir);
          logMessage(
            `Py-engine previous ${previousVariant} runtime parked for instant switch-back`,
            'info',
          );
        } catch (parkError) {
          // 驻留失败不影响安装结果，退回删除
          logMessage(
            `Py-engine failed to park previous runtime: ${parkError}`,
            'warning',
          );
          if (fs.existsSync(previousDir)) {
            fs.rmSync(previousDir, { recursive: true, force: true });
          }
        }
      } else {
        fs.rmSync(previousDir, { recursive: true, force: true });
      }
    }

    // 刚下载安装的变体即最新，同变体的驻留副本（若有）已过期 → 清理释放磁盘
    try {
      const staleParkedDir = getParkedEngineDir(this.engineId, variant);
      if (fs.existsSync(staleParkedDir)) {
        fs.rmSync(staleParkedDir, { recursive: true, force: true });
      }
    } catch (cleanError) {
      logMessage(
        `Py-engine failed to clean stale parked runtime: ${cleanError}`,
        'warning',
      );
    }
    logMessage('Py-engine installed and self-check passed', 'info');
  }

  private async rollback(hadPrevious: boolean): Promise<void> {
    const currentDir = getEngineDir(this.engineId);
    const previousDir = getPyEnginePreviousDir(this.engineId);

    // 先停机，释放刚失败的 current/ 句柄
    await shutdownPythonRuntime();

    if (fs.existsSync(currentDir)) {
      fs.rmSync(currentDir, { recursive: true, force: true });
    }

    if (hadPrevious && fs.existsSync(previousDir)) {
      // 旧包目录内含其 manifest，整目录还原即恢复版本戳
      fs.renameSync(previousDir, currentDir);
      try {
        await getPythonRuntimeManager().ensureStarted(this.engineId);
        logMessage('Py-engine rolled back to previous version', 'info');
      } catch (restartError) {
        logMessage(
          `Py-engine rollback restart failed: ${restartError}`,
          'error',
        );
      }
    }
    // 无旧版可退（首次安装失败）：current 已删除即回到未安装态（manifest 随目录消失）
  }
}

const downloaderInstances = new Map<PyEngineId, PyEngineDownloader>();

export function getPyEngineDownloader(
  engineId: PyEngineId,
  mainWindow?: BrowserWindow,
): PyEngineDownloader {
  let instance = downloaderInstances.get(engineId);
  if (!instance) {
    instance = new PyEngineDownloader(engineId, mainWindow);
    downloaderInstances.set(engineId, instance);
  } else if (mainWindow) {
    instance.setMainWindow(mainWindow);
  }
  return instance;
}
