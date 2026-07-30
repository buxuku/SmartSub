import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import type { ModelDownloadProgress } from '../modelDownloader';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from '../download/parallelDownloader';
import { extractArchive } from '../download/extractArchive';
import { logMessage } from '../storeManager';
import {
  SPEAKER_DIARIZATION_ASSETS,
  SPEAKER_DIARIZATION_DEFAULT_SOURCE,
  SPEAKER_DIARIZATION_DOWNLOAD_BYTES,
  SPEAKER_DIARIZATION_EMBEDDING_FILE,
  SPEAKER_DIARIZATION_PROGRESS_KEY,
  type SpeakerDiarizationModelSource,
  getSpeakerDiarizationAssetUrl,
  getSpeakerDiarizationModelDir,
  getSpeakerDiarizationModelsRoot,
  getSpeakerDiarizationSourceOrder,
  isSpeakerDiarizationModelInstalled,
  validateSpeakerDiarizationModelDir,
} from './modelCatalog';

const CANCELLED = 'Download cancelled';
const CONNECT_TIMEOUT = 30_000;

function redirectedUrl(current: string, location: string): string {
  return new URL(location, current).href;
}

export class SpeakerDiarizationModelDownloader {
  private mainWindow: BrowserWindow | null = null;
  private abortController: AbortController | null = null;
  private progress: ModelDownloadProgress = {
    status: 'idle',
    progress: 0,
    downloaded: 0,
    total: SPEAKER_DIARIZATION_DOWNLOAD_BYTES,
    speed: 0,
    eta: 0,
  };
  private startedAt = 0;

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
  }

  private emit(value?: number): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const ratio =
      value ??
      (this.progress.total > 0
        ? this.progress.downloaded / this.progress.total
        : 0);
    this.mainWindow.webContents.send(
      'downloadProgress',
      SPEAKER_DIARIZATION_PROGRESS_KEY,
      Math.max(0, Math.min(ratio, 1)),
    );
    this.mainWindow.webContents.send(
      'modelDownloadDetail',
      SPEAKER_DIARIZATION_PROGRESS_KEY,
      this.progress,
    );
  }

  private update(
    downloaded: number,
    status: ModelDownloadProgress['status'] = 'downloading',
  ): void {
    const elapsed = Math.max(0.001, (Date.now() - this.startedAt) / 1000);
    const speed = downloaded / elapsed;
    const remaining = Math.max(
      0,
      SPEAKER_DIARIZATION_DOWNLOAD_BYTES - downloaded,
    );
    this.progress = {
      ...this.progress,
      status,
      downloaded,
      total: SPEAKER_DIARIZATION_DOWNLOAD_BYTES,
      progress: Math.round(
        (downloaded / SPEAKER_DIARIZATION_DOWNLOAD_BYTES) * 100,
      ),
      speed,
      eta: speed > 0 ? remaining / speed : 0,
      error: undefined,
    };
    this.emit();
  }

  private async downloadSingle(
    url: string,
    destPath: string,
    offset: number,
    expectedBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const working = `${destPath}.download`;
    await fs.promises.rm(working, { force: true });
    await new Promise<void>((resolve, reject) => {
      const requestUrl = (currentUrl: string) => {
        const parsed = new URL(currentUrl);
        const protocol = parsed.protocol === 'https:' ? https : http;
        const req = protocol.get(
          currentUrl,
          { headers: { 'User-Agent': 'SmartSub-Electron' } },
          (response) => {
            if (
              response.statusCode &&
              response.statusCode >= 300 &&
              response.statusCode < 400 &&
              response.headers.location
            ) {
              response.destroy();
              requestUrl(redirectedUrl(currentUrl, response.headers.location));
              return;
            }
            if (!response.statusCode || response.statusCode >= 400) {
              response.destroy();
              reject(new Error(`HTTP Error: ${response.statusCode}`));
              return;
            }
            let downloaded = 0;
            const output = fs.createWriteStream(working, { flags: 'w' });
            response.on('data', (chunk: Buffer) => {
              downloaded += chunk.length;
              this.update(offset + Math.min(downloaded, expectedBytes));
            });
            response.pipe(output);
            output.on('close', resolve);
            output.on('error', reject);
          },
        );
        const onAbort = () => req.destroy(new Error(CANCELLED));
        signal?.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal?.removeEventListener('abort', onAbort));
        req.on('error', reject);
        req.setTimeout(CONNECT_TIMEOUT, () =>
          req.destroy(new Error('download connect timeout')),
        );
      };
      if (signal?.aborted) {
        reject(new Error(CANCELLED));
        return;
      }
      requestUrl(url);
    });
    if (signal?.aborted) throw new Error(CANCELLED);
    await fs.promises.rm(destPath, { force: true });
    await fs.promises.rename(working, destPath);
  }

  private async downloadAsset(input: {
    url: string;
    destPath: string;
    offset: number;
    expectedBytes: number;
    signal?: AbortSignal;
  }): Promise<void> {
    try {
      await downloadFileParallel({
        url: input.url,
        destPath: input.destPath,
        signal: input.signal,
        headers: { 'User-Agent': 'SmartSub-Electron' },
        onProgress: (downloaded) =>
          this.update(input.offset + Math.min(downloaded, input.expectedBytes)),
        log: (message, level) => logMessage(message, level),
      });
    } catch (error) {
      if (!(error instanceof RangeNotSupportedError)) throw error;
      await this.downloadSingle(
        input.url,
        input.destPath,
        input.offset,
        input.expectedBytes,
        input.signal,
      );
    }
    this.update(input.offset + input.expectedBytes);
  }

  private async downloadFromSource(
    source: SpeakerDiarizationModelSource,
  ): Promise<void> {
    const root = getSpeakerDiarizationModelsRoot();
    const staging = path.join(root, '.default.staging');
    const archive = path.join(
      staging,
      SPEAKER_DIARIZATION_ASSETS.segmentation.fileName,
    );
    const embedding = path.join(staging, SPEAKER_DIARIZATION_EMBEDDING_FILE);
    const signal = this.abortController?.signal;

    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.mkdir(staging, { recursive: true });
    try {
      await this.downloadAsset({
        url: getSpeakerDiarizationAssetUrl('segmentation', source),
        destPath: archive,
        offset: 0,
        expectedBytes: SPEAKER_DIARIZATION_ASSETS.segmentation.downloadBytes,
        signal,
      });
      if (
        fs.statSync(archive).size !==
        SPEAKER_DIARIZATION_ASSETS.segmentation.downloadBytes
      ) {
        throw new Error('segmentation archive size mismatch');
      }

      this.progress = { ...this.progress, status: 'extracting' };
      this.emit();
      await extractArchive({
        archivePath: archive,
        destDir: path.join(staging, 'pyannote'),
        strip: 1,
        signal,
      });
      await fs.promises.rm(archive, { force: true });

      await this.downloadAsset({
        url: getSpeakerDiarizationAssetUrl('embedding', source),
        destPath: embedding,
        offset: SPEAKER_DIARIZATION_ASSETS.segmentation.downloadBytes,
        expectedBytes: SPEAKER_DIARIZATION_ASSETS.embedding.downloadBytes,
        signal,
      });

      if (!validateSpeakerDiarizationModelDir(staging).ok) {
        throw new Error(
          'download finished but diarization model files are incomplete',
        );
      }

      const dest = getSpeakerDiarizationModelDir();
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.rename(staging, dest);
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async download(
    source: SpeakerDiarizationModelSource = SPEAKER_DIARIZATION_DEFAULT_SOURCE,
  ): Promise<boolean> {
    if (isSpeakerDiarizationModelInstalled()) return true;
    this.abortController = new AbortController();
    this.startedAt = Date.now();
    this.update(0);
    let lastError: unknown;

    for (const candidate of getSpeakerDiarizationSourceOrder(source)) {
      try {
        await this.downloadFromSource(candidate);
        if (!isSpeakerDiarizationModelInstalled()) {
          throw new Error('speaker diarization model validation failed');
        }
        this.progress = {
          ...this.progress,
          status: 'completed',
          progress: 100,
          downloaded: SPEAKER_DIARIZATION_DOWNLOAD_BYTES,
        };
        this.emit(1);
        this.abortController = null;
        logMessage(
          `speaker diarization model installed from ${candidate}`,
          'info',
        );
        return true;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (message === CANCELLED || this.abortController?.signal.aborted) {
          this.progress = { ...this.progress, status: 'idle' };
          this.emit(1);
          this.abortController = null;
          throw new Error(CANCELLED);
        }
        logMessage(
          `speaker diarization model source ${candidate} failed: ${message}`,
          'warning',
        );
      }
    }

    this.progress = {
      ...this.progress,
      status: 'error',
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
    this.emit(0);
    this.abortController = null;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

let downloader: SpeakerDiarizationModelDownloader | null = null;

export function getSpeakerDiarizationModelDownloader(
  mainWindow?: BrowserWindow,
): SpeakerDiarizationModelDownloader {
  if (!downloader) {
    downloader = new SpeakerDiarizationModelDownloader(mainWindow);
  } else if (mainWindow) {
    downloader.setMainWindow(mainWindow);
  }
  return downloader;
}
