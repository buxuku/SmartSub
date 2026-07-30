import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
  getParakeetModelsRoot,
  isParakeetModelInstalled,
} from './parakeetModelCatalog';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from './download/parallelDownloader';
import { extractArchive } from './download/extractArchive';
import { validateModelLayout } from './modelImport';
import { commitStagedDirectory } from './download/atomicDirectoryInstall';
import { DownloadSessionTracker } from './download/downloadSession';
import {
  downloadFileSingle,
  SINGLE_DOWNLOAD_CANCELLED,
} from './download/singleFileDownloader';

const CANCELLED = SINGLE_DOWNLOAD_CANCELLED;

export function getParakeetProgressKey(id: ParakeetModelId): string {
  return `parakeet:${id}`;
}

/**
 * NVIDIA Parakeet TDT 模型下载器：从 sherpa-onnx 官方 release 下载 tar.bz2，
 * 解包到 userData/models/parakeet/<id>/。复用断点续传、多连接、取消和独立进程解包。
 */
export class ParakeetModelDownloader {
  private abortController: AbortController | null = null;
  private mainWindow: BrowserWindow | null = null;
  private currentKey: string | null = null;
  private inFlight: Promise<boolean> | null = null;
  private readonly sessions = new DownloadSessionTracker();
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

  async cancel(): Promise<void> {
    const inFlight = this.inFlight;
    this.abortController?.abort();
    if (inFlight) {
      await inFlight.catch(() => {});
    }
  }

  private send(sessionId: number): void {
    if (
      !this.sessions.owns(sessionId) ||
      !this.mainWindow ||
      this.mainWindow.isDestroyed() ||
      !this.currentKey
    ) {
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

  private update(
    sessionId: number,
    patch: Partial<ModelDownloadProgress>,
  ): void {
    if (!this.sessions.owns(sessionId)) return;
    this.progress = { ...this.progress, ...patch };
    if (this.progress.total > 0) {
      this.progress.progress =
        (this.progress.downloaded / this.progress.total) * 100;
    }
    this.send(sessionId);
  }

  private sendFinal(sessionId: number, key: string, value: number): void {
    if (
      !this.sessions.owns(sessionId) ||
      !this.mainWindow ||
      this.mainWindow.isDestroyed()
    ) {
      return;
    }
    this.mainWindow.webContents.send('downloadProgress', key, value);
    this.mainWindow.webContents.send('modelDownloadDetail', key, this.progress);
  }

  private sendExtract(sessionId: number, ratio: number): void {
    if (!this.sessions.owns(sessionId)) return;
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
    if (this.inFlight) {
      throw new Error('another Parakeet model download is still finishing');
    }

    const sessionId = this.sessions.begin();
    const controller = new AbortController();
    this.abortController = controller;
    const run = this.runDownload(id, source, sessionId, controller.signal);
    const tracked = run.finally(() => {
      if (this.sessions.finish(sessionId)) {
        this.abortController = null;
        this.currentKey = null;
        this.inFlight = null;
      }
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async runDownload(
    id: ParakeetModelId,
    source: ParakeetModelSource,
    sessionId: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const spec = PARAKEET_MODELS[id];
    const key = getParakeetProgressKey(id);
    this.currentKey = key;
    this.update(sessionId, {
      status: 'downloading',
      downloaded: 0,
      total: 0,
      progress: 0,
      error: undefined,
    });

    let lastError: unknown = null;
    for (const currentSource of getParakeetSourceOrder(source)) {
      try {
        await this.downloadFromArchive(spec, currentSource, sessionId, signal);
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
        this.sendFinal(sessionId, key, 1);
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
          this.sendFinal(sessionId, key, 1);
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
    this.sendFinal(sessionId, key, 0);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async downloadFromArchive(
    spec: ParakeetModelSpec,
    source: ParakeetModelSource,
    sessionId: number,
    signal: AbortSignal,
  ): Promise<void> {
    const root = getParakeetModelsRoot();
    const destDir = path.join(root, spec.dirName);
    const transactionId = randomUUID();
    const stagedDir = `${destDir}.install-${transactionId}`;
    const backupDir = `${destDir}.backup-${transactionId}`;
    const tmp = path.join(
      root,
      `.${spec.dirName}.download-${transactionId}.tar.bz2`,
    );
    const url = getParakeetArchiveUrl(spec, source);
    this.update(sessionId, {
      status: 'downloading',
      downloaded: 0,
      total: 0,
      progress: 0,
      error: undefined,
    });

    try {
      await fs.promises.rm(stagedDir, { recursive: true, force: true });
      await fs.promises.rm(tmp, { force: true });
      await this.downloadArchive(url, tmp, sessionId, signal);
      this.progress = { ...this.progress, status: 'extracting' };
      this.sendExtract(sessionId, 0);
      await extractArchive({
        archivePath: tmp,
        destDir: stagedDir,
        strip: 1,
        excludeContains: 'test_wavs',
        approxTotalBytes: spec.approxInstallBytes,
        signal,
        onProgress: (ratio) => this.sendExtract(sessionId, ratio),
      });
      const validation = validateModelLayout(stagedDir, spec.requiredFiles);
      if (!validation.ok) {
        throw new Error(
          `extracted Parakeet model is incomplete: ${validation.missing.join(', ')}`,
        );
      }
      await commitStagedDirectory({
        stagedDir,
        destDir,
        backupDir,
        onCleanupWarning: (message) => logMessage(message, 'warning'),
      });
    } finally {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      // commit 成功后 staging 已被 rename；失败时只清新目录，保留原模型。
      await fs.promises
        .rm(stagedDir, { recursive: true, force: true })
        .catch(() => {});
    }
  }

  private async downloadArchive(
    url: string,
    dest: string,
    sessionId: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await downloadFileParallel({
        url,
        destPath: dest,
        signal,
        headers: { 'User-Agent': 'SmartSub-Electron' },
        onProgress: (downloaded, total) =>
          this.update(sessionId, { downloaded, total }),
        log: (message, level) => logMessage(message, level),
      });
    } catch (error) {
      if (error instanceof RangeNotSupportedError) {
        await downloadFileSingle({
          url,
          destPath: dest,
          signal,
          headers: { 'User-Agent': 'SmartSub-Electron' },
          onProgress: (downloaded, total) =>
            this.update(sessionId, { downloaded, total }),
        });
        return;
      }
      throw error;
    }
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
