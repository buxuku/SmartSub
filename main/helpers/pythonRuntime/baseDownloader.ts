import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import * as tar from 'tar';
import { logMessage } from '../storeManager';
import { calculateFileChecksum } from '../addonDownloader';
import type {
  PyBaseDownloadProgress,
  PyBaseManifest,
  PyBaseUpdateInfo,
  PyEngineDownloadSource,
  RemoteEngineManifest,
} from '../../../types/engine';
import {
  getBaseArtifactName,
  getBaseDownloadUrl,
  getPyBasePythonPath,
  getPyEngineArtifactSuffix,
  getPyEngineChecksumsUrl,
  getPyEngineManifestUrl,
  getUserPyBaseDir,
  readUserPyBaseManifest,
  writeUserPyBaseManifest,
} from './paths';
import { adhocResignDir } from './macSign';
import { shutdownPythonRuntime } from './index';
import { getSourceFallbackOrder } from '../downloadSourceOrder';
import { MirrorDownloader } from '../download/mirrorDownloader';

/** 下载/解压/备份的临时根（与基座同盘，保证 rename 原子替换）。 */
function scratchRoot(): string {
  return path.join(app.getPath('userData'), 'py-base', '.cache');
}
function tempTar(): string {
  return path.join(scratchRoot(), 'downloads', 'base.tar.gz');
}
function stagingDir(): string {
  return path.join(scratchRoot(), 'staging');
}
function previousDir(): string {
  return path.join(scratchRoot(), 'previous');
}

function fetchHttpText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const proto = parsed.protocol === 'https:' ? https : http;
    const req = proto.get(
      url,
      { headers: { 'User-Agent': 'SmartSub-Electron' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          const loc = res.headers.location;
          if (loc) {
            fetchHttpText(loc).then(resolve).catch(reject);
            return;
          }
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP Error: ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function parseChecksum(content: string, name: string): string | null {
  for (const line of content.split('\n')) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?\s*(.+)$/);
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Layer 1 基座下载器：复用 MirrorDownloader（多源回退/续传/进度），目标为
 * userData/py-base/current（resolvePyBaseDir 优先于内置基座）。
 * 与引擎下载器的区别：无协议门禁、无 sidecar 自检循环（但 swap 前必须停机，因为
 * 运行中的 sidecar 正使用基座解释器），自检 = 解释器导入关键 stdlib。
 */
export class PyBaseDownloader {
  private mainWindow: BrowserWindow | null = null;
  private core: MirrorDownloader;

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
    this.core = new MirrorDownloader((p) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(
          'py-base-download-progress',
          p as PyBaseDownloadProgress,
        );
      }
    });
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  getProgress(): PyBaseDownloadProgress {
    return this.core.getProgress() as PyBaseDownloadProgress;
  }

  cancel(): void {
    this.core.cancel();
  }

  async download(source: PyEngineDownloadSource): Promise<void> {
    return this.core.runWithFallback(
      source,
      (s) => this.downloadFromSource(s),
      (error) =>
        (error instanceof Error ? error.message : String(error)) ===
        'Download cancelled',
      'Py-base download',
      logMessage,
    );
  }

  /** 拉取远端 manifest.json（取 basePackage 版本信息）；不存在时返回 null。 */
  private async fetchRemoteManifest(
    source: PyEngineDownloadSource,
  ): Promise<RemoteEngineManifest | null> {
    for (const s of getSourceFallbackOrder(source)) {
      try {
        return JSON.parse(
          await fetchHttpText(getPyEngineManifestUrl(s)),
        ) as RemoteEngineManifest;
      } catch (e) {
        logMessage(`py-base manifest from ${s} unavailable: ${e}`, 'info');
      }
    }
    return null;
  }

  /**
   * 更新检测：以 checksums.sha256 中本平台 base 产物哈希为主信号，与本地
   * manifest.sha256 比对。仅在已存在「下载基座」时才有意义（内置基座无 sha256）。
   */
  async checkUpdate(source: PyEngineDownloadSource): Promise<PyBaseUpdateInfo> {
    const localManifest = readUserPyBaseManifest();
    let remoteHash: string | null = null;
    for (const s of getSourceFallbackOrder(source)) {
      try {
        remoteHash = parseChecksum(
          await fetchHttpText(getPyEngineChecksumsUrl(s)),
          getBaseArtifactName(),
        );
        if (remoteHash) break;
      } catch (e) {
        logMessage(
          `py-base checkUpdate checksums ${s} failed: ${e}`,
          'warning',
        );
      }
    }
    const remote = await this.fetchRemoteManifest(source);
    const remoteBase = remote?.basePackage ?? null;
    const hasUpdate = !!(
      remoteHash &&
      localManifest?.sha256 &&
      remoteHash.toLowerCase() !== localManifest.sha256.toLowerCase()
    );
    return { hasUpdate, localManifest, remoteBase, remoteHash };
  }

  private async downloadFromSource(
    source: PyEngineDownloadSource,
  ): Promise<void> {
    const url = getBaseDownloadUrl(source);
    const tar0 = tempTar();
    fs.mkdirSync(path.dirname(tar0), { recursive: true });

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

    const remote = await this.fetchRemoteManifest(source);
    const downloaded = await this.core.downloadFile(url, tar0, 0, {});
    this.core.updateProgress({ status: 'extracting' });
    await this.verifyExtractInstall(downloaded, source, remote);
    if (fs.existsSync(downloaded)) fs.unlinkSync(downloaded);
    this.core.updateProgress({ status: 'completed', progress: 100 });
    logMessage('Py-base downloaded and installed', 'info');
  }

  private async verifyExtractInstall(
    tarPath: string,
    source: PyEngineDownloadSource,
    remote: RemoteEngineManifest | null,
  ): Promise<void> {
    const name = getBaseArtifactName();
    const expected = parseChecksum(
      await fetchHttpText(getPyEngineChecksumsUrl(source)),
      name,
    );
    if (!expected) throw new Error(`Checksum for ${name} not found`);
    const actual = await calculateFileChecksum(tarPath);
    if (actual.toLowerCase() !== expected) {
      throw new Error(`Checksum mismatch: ${expected} vs ${actual}`);
    }

    const staging = stagingDir();
    if (fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    fs.mkdirSync(staging, { recursive: true });
    await tar.extract({ file: tarPath, cwd: staging });

    if (!fs.existsSync(getPyBasePythonPath(staging))) {
      throw new Error(
        'Invalid base package: interpreter missing after extract',
      );
    }

    const current = getUserPyBaseDir();
    const prev = previousDir();
    const hadPrev = fs.existsSync(current);

    // base 解释器可能正被运行中的 sidecar 使用：换入前必须停机（解 Windows 文件锁）。
    await shutdownPythonRuntime();

    if (fs.existsSync(prev)) fs.rmSync(prev, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(prev), { recursive: true });
    if (hadPrev) fs.renameSync(current, prev);

    fs.mkdirSync(path.dirname(current), { recursive: true });
    try {
      fs.renameSync(staging, current);
    } catch (e) {
      if (hadPrev && !fs.existsSync(current) && fs.existsSync(prev)) {
        fs.renameSync(prev, current);
      }
      throw e;
    }

    // macOS 无证书兜底：对换入的原生库 ad-hoc 重签。
    adhocResignDir(current);

    // 自检：解释器能导入关键 native stdlib。
    this.core.updateProgress({ status: 'verifying' });
    try {
      execFileSync(
        getPyBasePythonPath(current),
        ['-c', 'import ssl, ctypes, sqlite3, lzma'],
        { stdio: 'ignore' },
      );
    } catch (selfCheck) {
      logMessage(
        `Py-base self-check failed, rolling back: ${selfCheck}`,
        'error',
      );
      fs.rmSync(current, { recursive: true, force: true });
      if (hadPrev && fs.existsSync(prev)) fs.renameSync(prev, current);
      throw selfCheck;
    }

    const manifest: PyBaseManifest = {
      pythonVersion: remote?.basePackage?.pythonVersion ?? '3.12.10',
      platform: getPyEngineArtifactSuffix(),
      sha256: expected,
      installedAt: new Date().toISOString(),
      source: 'downloaded',
    };
    writeUserPyBaseManifest(manifest);
    if (fs.existsSync(prev)) fs.rmSync(prev, { recursive: true, force: true });
  }
}

let instance: PyBaseDownloader | null = null;

export function getPyBaseDownloader(
  mainWindow?: BrowserWindow,
): PyBaseDownloader {
  if (!instance) instance = new PyBaseDownloader(mainWindow);
  else if (mainWindow) instance.setMainWindow(mainWindow);
  return instance;
}
