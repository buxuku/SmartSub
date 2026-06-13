import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { logMessage } from './storeManager';
import type { ModelDownloadProgress } from './modelDownloader';
import {
  getCt2ModelCacheDir,
  getFasterWhisperModelsPath,
  resolveCt2ModelSnapshotDir,
  toCt2CacheDirName,
} from './modelCatalog';
import { getCt2HfRepo } from './fasterWhisperModelCatalog';

interface HfTreeEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

interface Ct2DownloadState {
  modelId: string;
  revision: string;
  files: Array<{ path: string; destPath: string; size: number }>;
  fileIndex: number;
  downloaded: number;
  total: number;
  source: string;
  startedAt: string;
  lastUpdatedAt: string;
}

const INACTIVITY_TIMEOUT = 60_000;
const CONNECT_TIMEOUT = 30_000;
const CT2_PROGRESS_PREFIX = 'ct2:';

export function getCt2ProgressKey(modelId: string): string {
  return `${CT2_PROGRESS_PREFIX}${modelId}`;
}

export function toHfRepoId(modelId: string): string {
  return getCt2HfRepo(modelId);
}

export function toHfCacheDirName(modelId: string): string {
  return toCt2CacheDirName(modelId);
}

function getDownloadStatePath(): string {
  return path.join(app.getPath('userData'), 'ct2-model-download-state.json');
}

function readDownloadState(): Ct2DownloadState | null {
  try {
    const statePath = getDownloadStatePath();
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8')) as Ct2DownloadState;
    }
  } catch (error) {
    logMessage(`Error reading CT2 model download state: ${error}`, 'error');
  }
  return null;
}

function saveDownloadState(state: Ct2DownloadState | null): void {
  try {
    const statePath = getDownloadStatePath();
    if (state === null) {
      if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    } else {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  } catch (error) {
    logMessage(`Error saving CT2 model download state: ${error}`, 'error');
  }
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).href;
}

function getHfHost(source: string): string {
  return source === 'huggingface' ? 'huggingface.co' : 'hf-mirror.com';
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;
    const request = protocol.get(
      url,
      { headers: { 'User-Agent': 'SmartSub-Electron' } },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          fetchJson<T>(resolveRedirectUrl(url, response.headers.location))
            .then(resolve)
            .catch(reject);
          return;
        }
        if (!response.statusCode || response.statusCode >= 400) {
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(CONNECT_TIMEOUT);
  });
}

export function isCt2ModelInstalled(modelId: string): boolean {
  return resolveCt2ModelSnapshotDir(modelId) !== null;
}

export class FasterWhisperModelDownloader {
  private abortController: AbortController | null = null;
  private mainWindow: BrowserWindow | null = null;
  private currentModel: string | null = null;
  private currentProgress: ModelDownloadProgress = {
    status: 'idle',
    progress: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: 0,
  };
  private lastSpeedCalcTime = 0;
  private lastSpeedCalcBytes = 0;

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  private sendProgress(): void {
    if (
      this.mainWindow &&
      !this.mainWindow.isDestroyed() &&
      this.currentModel
    ) {
      const rawProgress =
        this.currentProgress.total > 0
          ? this.currentProgress.downloaded / this.currentProgress.total
          : 0;
      const progressValue = Math.min(rawProgress, 0.99);
      this.mainWindow.webContents.send(
        'downloadProgress',
        this.currentModel,
        progressValue,
      );
      this.mainWindow.webContents.send(
        'modelDownloadDetail',
        this.currentModel,
        this.currentProgress,
      );
    }
  }

  private updateProgress(update: Partial<ModelDownloadProgress>): void {
    this.currentProgress = { ...this.currentProgress, ...update };

    const now = Date.now();
    if (now - this.lastSpeedCalcTime >= 1000) {
      const bytesPerSecond =
        ((this.currentProgress.downloaded - this.lastSpeedCalcBytes) * 1000) /
        (now - this.lastSpeedCalcTime);
      this.currentProgress.speed = Math.max(0, bytesPerSecond);

      if (bytesPerSecond > 0 && this.currentProgress.total > 0) {
        const remainingBytes =
          this.currentProgress.total - this.currentProgress.downloaded;
        this.currentProgress.eta = Math.ceil(remainingBytes / bytesPerSecond);
      }

      this.lastSpeedCalcTime = now;
      this.lastSpeedCalcBytes = this.currentProgress.downloaded;
    }

    if (this.currentProgress.total > 0) {
      this.currentProgress.progress =
        (this.currentProgress.downloaded / this.currentProgress.total) * 100;
    }

    this.sendProgress();
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.updateProgress({ status: 'idle' });
    this.currentModel = null;
  }

  async download(modelId: string, source: string): Promise<boolean> {
    if (isCt2ModelInstalled(modelId)) {
      return true;
    }

    const host = getHfHost(source);
    const repoId = toHfRepoId(modelId);
    const progressKey = getCt2ProgressKey(modelId);

    const modelInfo = await fetchJson<{ sha?: string }>(
      `https://${host}/api/models/${repoId}`,
    );
    const revision = modelInfo.sha;
    if (!revision) {
      throw new Error(`Failed to resolve revision for ${repoId}`);
    }

    const tree = await fetchJson<HfTreeEntry[]>(
      `https://${host}/api/models/${repoId}/tree/${revision}?recursive=true`,
    );
    const files = tree.filter(
      (entry) =>
        entry.type === 'file' &&
        entry.path &&
        !entry.path.startsWith('.') &&
        (entry.size ?? 0) > 0,
    );
    if (files.length === 0) {
      throw new Error(`No downloadable files found for ${repoId}`);
    }

    const cacheDir = getCt2ModelCacheDir(modelId);
    const snapshotDir = path.join(cacheDir, 'snapshots', revision);
    const refsDir = path.join(cacheDir, 'refs');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(refsDir, 'main'), revision);

    const plannedFiles = files.map((file) => ({
      path: file.path!,
      destPath: path.join(snapshotDir, file.path!),
      size: file.size ?? 0,
    }));
    const totalBytes = plannedFiles.reduce((sum, file) => sum + file.size, 0);

    this.currentModel = progressKey;
    this.abortController = new AbortController();
    this.lastSpeedCalcTime = Date.now();
    this.lastSpeedCalcBytes = 0;
    this.updateProgress({
      status: 'downloading',
      progress: 0,
      downloaded: 0,
      total: totalBytes,
      speed: 0,
      eta: 0,
      error: undefined,
    });

    let downloadedBytes = 0;
    let startFileIndex = 0;
    const existingState = readDownloadState();
    if (
      existingState &&
      existingState.modelId === modelId &&
      existingState.revision === revision &&
      existingState.source === source
    ) {
      downloadedBytes = existingState.downloaded;
      startFileIndex = existingState.fileIndex;
    }

    try {
      for (let i = startFileIndex; i < plannedFiles.length; i++) {
        const file = plannedFiles[i];
        fs.mkdirSync(path.dirname(file.destPath), { recursive: true });

        const url = `https://${host}/${repoId}/resolve/${revision}/${file.path}`;
        const tempPath = `${file.destPath}.download`;
        let startByte = 0;
        if (fs.existsSync(file.destPath)) {
          downloadedBytes += file.size;
          this.updateProgress({ downloaded: downloadedBytes });
          continue;
        }
        if (fs.existsSync(tempPath)) {
          startByte = fs.statSync(tempPath).size;
        }

        saveDownloadState({
          modelId,
          revision,
          files: plannedFiles,
          fileIndex: i,
          downloaded: downloadedBytes + startByte,
          total: totalBytes,
          source,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        });

        await this.downloadFile(
          url,
          tempPath,
          startByte,
          progressKey,
          downloadedBytes,
          totalBytes,
          file.size,
        );
        fs.renameSync(tempPath, file.destPath);
        downloadedBytes += file.size - startByte;
        this.updateProgress({ downloaded: downloadedBytes });
      }

      saveDownloadState(null);
      this.currentProgress = {
        ...this.currentProgress,
        status: 'completed',
        progress: 100,
        downloaded: totalBytes,
        total: totalBytes,
        speed: 0,
        eta: 0,
      };
      this.sendFinalProgress(progressKey, 1);
      logMessage(`CT2 model ${modelId} download completed`, 'info');
      this.currentModel = null;
      return true;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.currentProgress = {
        ...this.currentProgress,
        status: errorMessage === 'Download cancelled' ? 'idle' : 'error',
        error: errorMessage === 'Download cancelled' ? undefined : errorMessage,
        speed: 0,
        eta: 0,
      };
      if (errorMessage !== 'Download cancelled') {
        this.sendFinalProgress(progressKey, 0);
      } else {
        this.sendFinalProgress(progressKey, 1);
      }
      logMessage(
        `CT2 model ${modelId} download failed: ${errorMessage}`,
        'error',
      );
      this.currentModel = null;
      throw error;
    }
  }

  private sendFinalProgress(model: string, value: number): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('downloadProgress', model, value);
      this.mainWindow.webContents.send(
        'modelDownloadDetail',
        model,
        this.currentProgress,
      );
    }
  }

  private downloadFile(
    url: string,
    destPath: string,
    startByte: number,
    progressKey: string,
    baseDownloaded: number,
    totalBytes: number,
    fileSize: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {
        'User-Agent': 'SmartSub-Electron',
      };
      if (startByte > 0) {
        headers.Range = `bytes=${startByte}-`;
      }

      let isCompleted = false;
      let inactivityTimer: NodeJS.Timeout | null = null;
      const signal = this.abortController?.signal;

      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (!isCompleted) {
          inactivityTimer = setTimeout(() => {
            if (!isCompleted) {
              request.destroy();
              reject(
                new Error('Download timeout: no data received for 60 seconds'),
              );
            }
          }, INACTIVITY_TIMEOUT);
        }
      };

      const clearInactivityTimer = () => {
        if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = null;
        }
      };

      const onAbort = () => {
        if (!isCompleted) {
          isCompleted = true;
          clearInactivityTimer();
          request.destroy();
          reject(new Error('Download cancelled'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const request = protocol.get(url, { headers }, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          clearInactivityTimer();
          this.downloadFile(
            resolveRedirectUrl(url, response.headers.location),
            destPath,
            startByte,
            progressKey,
            baseDownloaded,
            totalBytes,
            fileSize,
          )
            .then(resolve)
            .catch(reject);
          return;
        }

        if (!response.statusCode || response.statusCode >= 400) {
          clearInactivityTimer();
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(destPath, {
          flags: startByte > 0 ? 'a' : 'w',
        });
        let fileDownloaded = startByte;

        response.on('data', (chunk: Buffer) => {
          fileDownloaded += chunk.length;
          this.updateProgress({
            downloaded: baseDownloaded + fileDownloaded,
            total: totalBytes,
            status: 'downloading',
          });
          resetInactivityTimer();
        });

        response.pipe(fileStream);

        fileStream.on('finish', () => {
          isCompleted = true;
          clearInactivityTimer();
          signal?.removeEventListener('abort', onAbort);
          if (fileDownloaded < fileSize && response.statusCode === 200) {
            resolve();
            return;
          }
          resolve();
        });

        fileStream.on('error', (error) => {
          isCompleted = true;
          clearInactivityTimer();
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        });
      });

      request.on('error', (error) => {
        isCompleted = true;
        clearInactivityTimer();
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });

      request.setTimeout(CONNECT_TIMEOUT);
      resetInactivityTimer();
    });
  }
}

let ct2DownloaderInstance: FasterWhisperModelDownloader | null = null;

export function getFasterWhisperModelDownloader(
  mainWindow?: BrowserWindow,
): FasterWhisperModelDownloader {
  if (!ct2DownloaderInstance) {
    ct2DownloaderInstance = new FasterWhisperModelDownloader(mainWindow);
  } else if (mainWindow) {
    ct2DownloaderInstance.setMainWindow(mainWindow);
  }
  return ct2DownloaderInstance;
}

export function deleteCt2Model(modelId: string): void {
  const cacheDirName = toCt2CacheDirName(modelId);
  const roots = [
    path.join(getFasterWhisperModelsPath(), 'hub'),
    getFasterWhisperModelsPath(),
    path.join(app.getPath('userData'), 'py-engine-cache', 'hub'),
    path.join(app.getPath('userData'), 'py-engine-cache'),
  ];

  for (const root of roots) {
    const cacheDir = path.join(root, cacheDirName);
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      logMessage(`Deleted CT2 model cache: ${cacheDir}`, 'info');
    }
  }

  const state = readDownloadState();
  if (state?.modelId === modelId) {
    saveDownloadState(null);
  }
}
