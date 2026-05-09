import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import decompress from 'decompress';
import { logMessage } from './storeManager';
import { getPath } from './whisper';
import { isAppleSilicon } from './utils';
import {
  REAZON_SPEECH_K2_V2_FILES,
  REAZON_SPEECH_K2_V2_MODEL,
} from '../../types';

export interface ModelDownloadProgress {
  status: 'idle' | 'downloading' | 'extracting' | 'completed' | 'error';
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
}

interface ModelDownloadState {
  url: string;
  tempPath: string;
  downloaded: number;
  total: number;
  model: string;
  startedAt: string;
  lastUpdatedAt: string;
}

const INACTIVITY_TIMEOUT = 60000;
const CONNECT_TIMEOUT = 30000;

function getDownloadStatePath(): string {
  return path.join(app.getPath('userData'), 'model-download-state.json');
}

function readDownloadState(): ModelDownloadState | null {
  try {
    const statePath = getDownloadStatePath();
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    logMessage(`Error reading model download state: ${error}`, 'error');
  }
  return null;
}

function saveDownloadState(state: ModelDownloadState | null): void {
  try {
    const statePath = getDownloadStatePath();
    if (state === null) {
      if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    } else {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  } catch (error) {
    logMessage(`Error saving model download state: ${error}`, 'error');
  }
}

export class ModelDownloader {
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

  async download(
    model: string,
    source: string,
    needsCoreML: boolean,
  ): Promise<boolean> {
    if (model === REAZON_SPEECH_K2_V2_MODEL) {
      return this.downloadReazonSpeechModel(model, source);
    }

    const modelsPath = getPath('modelsPath') as string;
    const modelPath = path.join(modelsPath, `ggml-${model}.bin`);
    const coreMLModelPath = path.join(
      modelsPath,
      `ggml-${model}-encoder.mlmodelc`,
    );

    const needDownloadMain = !fs.existsSync(modelPath);
    const needDownloadCoreML =
      needsCoreML && isAppleSilicon() && !fs.existsSync(coreMLModelPath);

    if (!needDownloadMain && !needDownloadCoreML) {
      return true;
    }

    const baseUrl = `https://${
      source === 'huggingface' ? 'huggingface.co' : 'hf-mirror.com'
    }/ggerganov/whisper.cpp/resolve/main`;

    this.currentModel = model;
    this.abortController = new AbortController();
    this.lastSpeedCalcTime = Date.now();
    this.lastSpeedCalcBytes = 0;

    this.updateProgress({
      status: 'downloading',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: 0,
      error: undefined,
    });

    try {
      if (needDownloadMain) {
        const url = `${baseUrl}/ggml-${model}.bin`;
        const tempPath = `${modelPath}.download`;

        const existingState = readDownloadState();
        let startByte = 0;

        if (
          existingState &&
          existingState.url === url &&
          existingState.model === model &&
          existingState.tempPath === tempPath &&
          fs.existsSync(existingState.tempPath)
        ) {
          const stat = fs.statSync(existingState.tempPath);
          startByte = stat.size;
          if (existingState.total > 0 && stat.size >= existingState.total) {
            fs.renameSync(existingState.tempPath, modelPath);
            saveDownloadState(null);
            logMessage(`Model ${model} download already complete`, 'info');
          } else {
            this.updateProgress({
              downloaded: startByte,
              total: existingState.total,
            });
            logMessage(
              `Resuming model ${model} download from byte ${startByte}`,
              'info',
            );
            await this.downloadFile(url, tempPath, startByte, model);
            fs.renameSync(tempPath, modelPath);
            saveDownloadState(null);
          }
        } else {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          await this.downloadFile(url, tempPath, 0, model);
          fs.renameSync(tempPath, modelPath);
          saveDownloadState(null);
        }
      }

      if (needDownloadCoreML) {
        const coreMLUrl = `${baseUrl}/ggml-${model}-encoder.mlmodelc.zip`;
        const coreMLZipPath = path.join(
          modelsPath,
          `ggml-${model}-encoder.mlmodelc.zip`,
        );
        const coreMLTempPath = `${coreMLZipPath}.download`;

        this.updateProgress({ status: 'downloading' });
        await this.downloadFile(coreMLUrl, coreMLTempPath, 0, model);
        fs.renameSync(coreMLTempPath, coreMLZipPath);

        this.updateProgress({ status: 'extracting' });
        await decompress(coreMLZipPath, modelsPath);
        fs.unlinkSync(coreMLZipPath);
        logMessage(`CoreML model ${model} extracted`, 'info');
      }

      this.currentProgress = {
        ...this.currentProgress,
        status: 'completed',
        progress: 100,
        speed: 0,
        eta: 0,
      };
      this.sendFinalProgress(model, 1);
      logMessage(`Model ${model} download completed`, 'info');
      this.currentModel = null;
      return true;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (errorMessage === 'Download cancelled') {
        this.currentProgress = {
          ...this.currentProgress,
          status: 'idle',
          error: 'Download cancelled',
          speed: 0,
          eta: 0,
        };
      } else {
        this.currentProgress = {
          ...this.currentProgress,
          status: 'error',
          error: errorMessage,
          speed: 0,
          eta: 0,
        };
      }

      this.sendFinalProgress(model, 1);
      logMessage(`Model ${model} download failed: ${errorMessage}`, 'error');
      this.currentModel = null;
      throw error;
    }
  }

  async downloadReazonSpeechModel(
    model: string,
    source: string,
  ): Promise<boolean> {
    const modelsPath = getPath('modelsPath') as string;
    const modelDir = path.join(modelsPath, model);
    const baseUrl = `https://${
      source === 'huggingface' ? 'huggingface.co' : 'hf-mirror.com'
    }/reazon-research/reazonspeech-k2-v2/resolve/main`;

    if (model !== REAZON_SPEECH_K2_V2_MODEL) {
      throw new Error(`Unsupported ReazonSpeech model: ${model}`);
    }

    fs.mkdirSync(modelDir, { recursive: true });

    const missingFiles = REAZON_SPEECH_K2_V2_FILES.filter(
      (file) => !fs.existsSync(path.join(modelDir, file)),
    );

    if (missingFiles.length === 0) {
      return true;
    }

    this.currentModel = model;
    this.abortController = new AbortController();
    this.lastSpeedCalcTime = Date.now();
    this.lastSpeedCalcBytes = 0;
    this.updateProgress({
      status: 'downloading',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: 0,
      error: undefined,
    });

    try {
      for (const file of missingFiles) {
        const url = `${baseUrl}/${file}`;
        const destPath = path.join(modelDir, file);
        const tempPath = `${destPath}.download`;
        const existingState = readDownloadState();
        let startByte = 0;

        if (
          existingState &&
          existingState.url === url &&
          existingState.model === model &&
          existingState.tempPath === tempPath &&
          fs.existsSync(existingState.tempPath)
        ) {
          startByte = fs.statSync(existingState.tempPath).size;
          if (existingState.total > 0 && startByte >= existingState.total) {
            fs.renameSync(tempPath, destPath);
            saveDownloadState(null);
            continue;
          }
        } else if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        logMessage(`Downloading ReazonSpeech K2 v2 file: ${file}`, 'info');
        await this.downloadFile(url, tempPath, startByte, model);
        fs.renameSync(tempPath, destPath);
        saveDownloadState(null);
      }

      this.currentProgress = {
        ...this.currentProgress,
        status: 'completed',
        progress: 100,
        speed: 0,
        eta: 0,
      };
      this.sendFinalProgress(model, 1);
      logMessage(`Model ${model} download completed`, 'info');
      this.currentModel = null;
      return true;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.currentProgress = {
        ...this.currentProgress,
        status: errorMessage === 'Download cancelled' ? 'idle' : 'error',
        error: errorMessage,
        speed: 0,
        eta: 0,
      };
      this.sendFinalProgress(model, 1);
      logMessage(`Model ${model} download failed: ${errorMessage}`, 'error');
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
    model: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const headers: Record<string, string> = {
        'User-Agent': 'SmartSub-Electron',
      };

      if (startByte > 0) {
        headers['Range'] = `bytes=${startByte}-`;
      }

      let isCompleted = false;
      let inactivityTimer: NodeJS.Timeout | null = null;

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

      const request = protocol.get(url, { headers }, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400
        ) {
          clearInactivityTimer();
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFile(redirectUrl, destPath, startByte, model)
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        if (response.statusCode && response.statusCode >= 400) {
          clearInactivityTimer();
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }

        let totalSize = 0;
        if (response.statusCode === 206) {
          const contentRange = response.headers['content-range'];
          if (contentRange) {
            const match = contentRange.match(/\/(\d+)$/);
            if (match) totalSize = parseInt(match[1], 10);
          }
        } else {
          const contentLength = response.headers['content-length'];
          if (contentLength) {
            totalSize = parseInt(contentLength, 10) + startByte;
          }
        }

        this.updateProgress({ total: totalSize, downloaded: startByte });

        const state: ModelDownloadState = {
          url,
          tempPath: destPath,
          downloaded: startByte,
          total: totalSize,
          model,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        };
        saveDownloadState(state);

        const writeStream = fs.createWriteStream(destPath, {
          flags: startByte > 0 ? 'a' : 'w',
        });

        let downloadedBytes = startByte;

        resetInactivityTimer();

        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          this.updateProgress({ downloaded: downloadedBytes });
          resetInactivityTimer();

          state.downloaded = downloadedBytes;
          state.lastUpdatedAt = new Date().toISOString();
          saveDownloadState(state);
        });

        response.on('end', () => {
          clearInactivityTimer();
        });

        response.pipe(writeStream);

        writeStream.on('finish', () => {
          isCompleted = true;
          clearInactivityTimer();
          resolve(destPath);
        });

        writeStream.on('error', (err) => {
          isCompleted = true;
          clearInactivityTimer();
          reject(err);
        });

        if (this.abortController) {
          this.abortController.signal.addEventListener('abort', () => {
            isCompleted = true;
            clearInactivityTimer();
            request.destroy();
            writeStream.close();
            reject(new Error('Download cancelled'));
          });
        }
      });

      request.on('error', (err) => {
        isCompleted = true;
        clearInactivityTimer();
        reject(err);
      });

      request.setTimeout(CONNECT_TIMEOUT);
      resetInactivityTimer();
    });
  }
}

let downloaderInstance: ModelDownloader | null = null;

export function getModelDownloader(
  mainWindow?: BrowserWindow,
): ModelDownloader {
  if (!downloaderInstance) {
    downloaderInstance = new ModelDownloader(mainWindow);
  } else if (mainWindow) {
    downloaderInstance.setMainWindow(mainWindow);
  }
  return downloaderInstance;
}
