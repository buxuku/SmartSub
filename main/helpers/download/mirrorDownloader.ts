import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import {
  getSourceFallbackOrder,
  type BinaryDownloadSource,
} from '../downloadSourceOrder';

export type MirrorStatus =
  | 'idle'
  | 'downloading'
  | 'extracting'
  | 'verifying'
  | 'completed'
  | 'error';

export interface MirrorProgress {
  status: MirrorStatus;
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
}

/** 下载过程中回报字节，供适配层持久化各自的续传 state 形状。 */
export interface DownloadFileHooks {
  onBytes?: (downloaded: number, total: number) => void;
}

type LogFn = (msg: string, level: 'info' | 'warning' | 'error') => void;

/**
 * 镜像下载核心：进度数学 + 多源回退 + 断点续传单文件下载（Range/重定向/206/
 * 60s 无活动超时/30s 连接超时/abort）。不感知 addon/py 的产物语义。
 */
export class MirrorDownloader {
  private abortController: AbortController | null = null;
  private progress: MirrorProgress = {
    status: 'idle',
    progress: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: 0,
  };
  private lastSpeedCalcTime = 0;
  private lastSpeedCalcBytes = 0;

  constructor(private readonly emit: (p: MirrorProgress) => void) {}

  getProgress(): MirrorProgress {
    return { ...this.progress };
  }

  /** 每次下载前重置 abort 控制器与速度基线。 */
  resetForDownload(): void {
    this.abortController = new AbortController();
    this.lastSpeedCalcTime = Date.now();
    this.lastSpeedCalcBytes = 0;
  }

  updateProgress(update: Partial<MirrorProgress>): void {
    this.progress = { ...this.progress, ...update };

    const now = Date.now();
    if (now - this.lastSpeedCalcTime >= 1000) {
      const bytesPerSecond =
        ((this.progress.downloaded - this.lastSpeedCalcBytes) * 1000) /
        (now - this.lastSpeedCalcTime);
      this.progress.speed = Math.max(0, bytesPerSecond);

      if (bytesPerSecond > 0 && this.progress.total > 0) {
        const remainingBytes = this.progress.total - this.progress.downloaded;
        this.progress.eta = Math.ceil(remainingBytes / bytesPerSecond);
      }

      this.lastSpeedCalcTime = now;
      this.lastSpeedCalcBytes = this.progress.downloaded;
    }

    if (this.progress.total > 0) {
      this.progress.progress =
        (this.progress.downloaded / this.progress.total) * 100;
    }

    this.emit({ ...this.progress });
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.updateProgress({ status: 'idle' });
  }

  /**
   * 按所选源 + 回退顺序依次尝试 attempt；isTerminalError 命中时不再换源（取消/协议）。
   */
  async runWithFallback<T>(
    source: BinaryDownloadSource,
    attempt: (s: BinaryDownloadSource) => Promise<T>,
    isTerminalError: (e: unknown) => boolean,
    logLabel: string,
    log: LogFn,
  ): Promise<T> {
    const order = getSourceFallbackOrder(source);
    let lastError: unknown;
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      try {
        if (i > 0) log(`${logLabel} falling back to source: ${s}`, 'warning');
        return await attempt(s);
      } catch (error) {
        if (isTerminalError(error)) throw error;
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        log(
          `${logLabel} from ${s} failed: ${msg}; ${
            i < order.length - 1 ? 'trying next source' : 'no more sources'
          }`,
          'warning',
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 断点续传单文件下载。resolve 为 destPath。取消时 reject('Download cancelled')。 */
  downloadFile(
    url: string,
    destPath: string,
    startByte: number,
    hooks?: DownloadFileHooks,
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

      const INACTIVITY_TIMEOUT = 60000;
      let inactivityTimer: NodeJS.Timeout | null = null;
      let isCompleted = false;

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
            this.downloadFile(redirectUrl, destPath, startByte, hooks)
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
          if (contentLength)
            totalSize = parseInt(contentLength, 10) + startByte;
        }

        this.updateProgress({ total: totalSize, downloaded: startByte });
        hooks?.onBytes?.(startByte, totalSize);

        const writeStream = fs.createWriteStream(destPath, {
          flags: startByte > 0 ? 'a' : 'w',
        });

        let downloadedBytes = startByte;
        resetInactivityTimer();

        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          this.updateProgress({ downloaded: downloadedBytes });
          resetInactivityTimer();
          hooks?.onBytes?.(downloadedBytes, totalSize);
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

      request.setTimeout(30000, () => {
        // 仅用于建立连接；一旦开始接收数据由 inactivityTimer 接管
      });

      resetInactivityTimer();
    });
  }
}
