import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { logMessage } from './storeManager';
import type { ModelDownloadProgress } from './modelDownloader';
import {
  PARAKEET_MODELS,
  ParakeetModelId,
  ParakeetModelSource,
  ParakeetModelSpec,
  PARAKEET_DEFAULT_SOURCE,
  getParakeetSourceOrder,
  getParakeetArchiveUrl,
  getParakeetModelDir,
  getParakeetModelsRoot,
  isParakeetModelInstalled,
} from './parakeetModelCatalog';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from './download/parallelDownloader';
import { extractArchive } from './download/extractArchive';

const CONNECT_TIMEOUT = 30_000;
const CANCELLED = 'Download cancelled';

export function getParakeetProgressKey(id: ParakeetModelId): string {
  return `parakeet:${id}`;
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).href;
}

/**
 * NVIDIA Parakeet TDT 模型下载器：从 sherpa-onnx 官方 release 下载 tar.bz2，
 * 解包到 userData/models/parakeet/<id>/。复用断点续传、多连接、取消和独立进程解包。
 */
export class ParakeetModelDownloader {
  private abortController: AbortController | null = null;
  private mainWindow: BrowserWindow | null = null;
  private currentKey: string | null = null;
  private progress: ModelDownloadProgress = {
    status: 'idle',
    progress: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: 0,
  };

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.progress = { ...this.progress, status: 'idle' };
    this.currentKey = null;
  }

  private send(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.currentKey) {
      return;
    }
    const ratio =
      this.progress.total > 0
        ? this.progress.downloaded / this.progress.total
        : 0;
    this.mainWindow.webContents.send(
      'downloadProgress',
      this.currentKey,
      Math.min(ratio, 0.99),
    );
    this.mainWindow.webContents.send(
      'modelDownloadDetail',
      this.currentKey,
      this.progress,
    );
  }

  private update(patch: Partial<ModelDownloadProgress>): void {
    this.progress = { ...this.progress, ...patch };
    if (this.progress.total > 0) {
      this.progress.progress =
        (this.progress.downloaded / this.progress.total) * 100;
    }
    this.send();
  }

  private sendFinal(key: string, value: number): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send('downloadProgress', key, value);
    this.mainWindow.webContents.send('modelDownloadDetail', key, this.progress);
  }

  private sendExtract(ratio: number): void {
    const capped = Math.min(ratio, 0.99);
    this.progress = {
      ...this.progress,
      status: 'extracting',
      progress: Math.round(capped * 100),
    };
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.currentKey) {
      return;
    }
    this.mainWindow.webContents.send(
      'downloadProgress',
      this.currentKey,
      capped,
    );
    this.mainWindow.webContents.send(
      'modelDownloadDetail',
      this.currentKey,
      this.progress,
    );
  }

  async download(
    id: ParakeetModelId,
    source: ParakeetModelSource = PARAKEET_DEFAULT_SOURCE,
  ): Promise<boolean> {
    if (isParakeetModelInstalled(id)) return true;
    const spec = PARAKEET_MODELS[id];
    const key = getParakeetProgressKey(id);
    this.currentKey = key;
    this.abortController = new AbortController();
    this.update({
      status: 'downloading',
      downloaded: 0,
      total: 0,
      progress: 0,
      error: undefined,
    });

    let lastError: unknown = null;
    for (const currentSource of getParakeetSourceOrder(source)) {
      try {
        await this.downloadFromArchive(spec, currentSource);
        if (!isParakeetModelInstalled(id)) {
          throw new Error(
            `download finished but required files missing for ${id}: ${spec.requiredFiles.join(', ')}`,
          );
        }
        this.progress = {
          ...this.progress,
          status: 'completed',
          progress: 100,
        };
        this.sendFinal(key, 1);
        this.currentKey = null;
        logMessage(
          `parakeet model ${id} installed from ${currentSource}`,
          'info',
        );
        return true;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (message === CANCELLED) {
          this.progress = { ...this.progress, status: 'idle' };
          this.sendFinal(key, 1);
          this.currentKey = null;
          throw error;
        }
        logMessage(
          `parakeet model ${id} from ${currentSource} failed: ${message}`,
          'warning',
        );
      }
    }

    this.progress = {
      ...this.progress,
      status: 'error',
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
    this.sendFinal(key, 0);
    this.currentKey = null;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async downloadFromArchive(
    spec: ParakeetModelSpec,
    source: ParakeetModelSource,
  ): Promise<void> {
    const destDir = getParakeetModelDir(spec.id);
    const tmp = path.join(getParakeetModelsRoot(), spec.archiveName);
    const url = getParakeetArchiveUrl(spec, source);
    this.update({
      status: 'downloading',
      downloaded: 0,
      total: 0,
      progress: 0,
      error: undefined,
    });

    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
      await this.downloadArchive(url, tmp);
      this.progress = { ...this.progress, status: 'extracting' };
      this.sendExtract(0);
      await extractArchive({
        archivePath: tmp,
        destDir,
        strip: 1,
        excludeContains: 'test_wavs',
        approxTotalBytes: spec.approxInstallBytes,
        signal: this.abortController?.signal,
        onProgress: (ratio) => this.sendExtract(ratio),
      });
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    }
  }

  private async downloadArchive(url: string, dest: string): Promise<void> {
    try {
      await downloadFileParallel({
        url,
        destPath: dest,
        signal: this.abortController?.signal,
        headers: { 'User-Agent': 'SmartSub-Electron' },
        onProgress: (downloaded, total) => this.update({ downloaded, total }),
        log: (message, level) => logMessage(message, level),
      });
    } catch (error) {
      if (error instanceof RangeNotSupportedError) {
        await this.downloadSingle(url, dest, this.abortController?.signal);
        return;
      }
      throw error;
    }
  }

  private downloadSingle(
    url: string,
    destPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const protocol = parsed.protocol === 'https:' ? https : http;
      const onAbort = () => {
        req.destroy();
        reject(new Error(CANCELLED));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const req = protocol.get(
        url,
        { headers: { 'User-Agent': 'SmartSub-Electron' } },
        (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            signal?.removeEventListener('abort', onAbort);
            this.downloadSingle(
              resolveRedirectUrl(url, response.headers.location),
              destPath,
              signal,
            )
              .then(resolve)
              .catch(reject);
            return;
          }
          if (!response.statusCode || response.statusCode >= 400) {
            reject(new Error(`HTTP Error: ${response.statusCode}`));
            return;
          }
          const total = Number(response.headers['content-length'] || 0);
          let downloaded = 0;
          response.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            this.update({ downloaded, total });
          });
          const output = fs.createWriteStream(destPath, { flags: 'w' });
          response.pipe(output);
          output.on('finish', () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
          output.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(CONNECT_TIMEOUT);
    });
  }
}

let instance: ParakeetModelDownloader | null = null;

export function getParakeetModelDownloader(
  mainWindow?: BrowserWindow,
): ParakeetModelDownloader {
  if (!instance) instance = new ParakeetModelDownloader(mainWindow);
  else if (mainWindow) instance.setMainWindow(mainWindow);
  return instance;
}
