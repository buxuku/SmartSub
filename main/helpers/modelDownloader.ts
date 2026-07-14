import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import decompress from 'decompress';
import { logMessage } from './storeManager';
import { getPath, isValidMlmodelc } from './whisper';
import { isAppleSilicon } from './utils';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from './download/parallelDownloader';
import { getHfHost } from './config/downloadConfig';

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
    const modelsPath = getPath('modelsPath') as string;
    const modelPath = path.join(modelsPath, `ggml-${model}.bin`);
    const coreMLModelPath = path.join(
      modelsPath,
      `ggml-${model}-encoder.mlmodelc`,
    );

    const needDownloadMain = !fs.existsSync(modelPath);
    // 目录存在但残缺（解压中断/强退遗留）同样视为需要重下——残缺 mlmodelc 会让 CoreML 加载挂死
    const needDownloadCoreML =
      needsCoreML && isAppleSilicon() && !isValidMlmodelc(coreMLModelPath);

    if (!needDownloadMain && !needDownloadCoreML) {
      return true;
    }

    if (needDownloadCoreML && fs.existsSync(coreMLModelPath)) {
      logMessage(
        `CoreML model ${model} is incomplete/corrupted, removing and re-downloading`,
        'warning',
      );
      fs.rmSync(coreMLModelPath, { recursive: true, force: true });
    }

    const baseUrl = `${getHfHost(source)}/ggerganov/whisper.cpp/resolve/main`;

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
          await this.downloadToFinal(url, modelPath, tempPath, model);
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
        await this.downloadToFinal(
          coreMLUrl,
          coreMLZipPath,
          coreMLTempPath,
          model,
        );

        this.updateProgress({ status: 'extracting' });
        await decompress(coreMLZipPath, modelsPath);
        fs.unlinkSync(coreMLZipPath);
        // 清理 zip 附带的 macOS 元数据目录
        const macosxDir = path.join(modelsPath, '__MACOSX');
        if (fs.existsSync(macosxDir)) {
          fs.rmSync(macosxDir, { recursive: true, force: true });
        }
        // 解压后完整性校验：残缺目录立即删除，避免下次转写走 CoreML 挂死
        if (!isValidMlmodelc(coreMLModelPath)) {
          fs.rmSync(coreMLModelPath, { recursive: true, force: true });
          throw new Error(
            `CoreML model ${model} extraction incomplete or corrupted, please retry the download`,
          );
        }
        logMessage(`CoreML model ${model} extracted and verified`, 'info');
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

  /**
   * 全新下载到 finalPath：优先多连接并行（写 .par 校验后改名），不支持/失败则
   * 回退单连接下载到 tempPath 再改名。取消错误向上抛出。
   */
  private async downloadToFinal(
    url: string,
    finalPath: string,
    tempPath: string,
    model: string,
  ): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal?.aborted) {
      try {
        await downloadFileParallel({
          url,
          destPath: finalPath,
          signal,
          headers: { 'User-Agent': 'SmartSub-Electron' },
          onProgress: (downloaded, total) => {
            this.updateProgress({ downloaded, total, status: 'downloading' });
          },
          log: (message, level) => logMessage(message, level),
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Download cancelled') throw error;
        logMessage(
          `Model ${model} parallel download fallback (${message})`,
          error instanceof RangeNotSupportedError ? 'info' : 'warning',
        );
      }
    }

    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    await this.downloadFile(url, tempPath, 0, model);
    fs.renameSync(tempPath, finalPath);
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
