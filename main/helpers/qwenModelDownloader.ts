import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { logMessage } from './storeManager';
import type { ModelDownloadProgress } from './modelDownloader';
import {
  QWEN_MODELS,
  QwenModelId,
  getQwenModelDir,
  getQwenModelsRoot,
  isQwenModelInstalled,
} from './qwenModelCatalog';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from './download/parallelDownloader';
import { extractArchive } from './download/extractArchive';

const CONNECT_TIMEOUT = 30_000;
const CANCELLED = 'Download cancelled';

/** 进度 key：qwen:<modelId>，与 funasr:<id> / ct2:<id> 同构，渲染层按前缀路由。 */
export function getQwenProgressKey(id: QwenModelId): string {
  return `qwen:${id}`;
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).href;
}

/**
 * Qwen 模型下载器：整包（tar.bz2）下载 + 解包到 userData/models/qwen/<id>/。
 * 复用 downloadFileParallel（断点续传 + 多连接 + 取消），解包用 decompress（含 tarbz2 插件）。
 * 与 FunasrModelDownloader 同构（同事件名 downloadProgress / modelDownloadDetail）。
 */
export class QwenModelDownloader {
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
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.progress = { ...this.progress, status: 'idle' };
    this.currentKey = null;
  }

  private send(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.currentKey) {
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
  }

  private update(p: Partial<ModelDownloadProgress>): void {
    this.progress = { ...this.progress, ...p };
    if (this.progress.total > 0) {
      this.progress.progress =
        (this.progress.downloaded / this.progress.total) * 100;
    }
    this.send();
  }

  private sendFinal(key: string, value: number): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('downloadProgress', key, value);
      this.mainWindow.webContents.send(
        'modelDownloadDetail',
        key,
        this.progress,
      );
    }
  }

  /** 解包阶段进度：复用 downloadProgress 让进度条继续走，status='extracting' 供 UI 显示「解包中」。 */
  private sendExtract(ratio: number): void {
    const capped = Math.min(ratio, 0.99);
    this.progress = {
      ...this.progress,
      status: 'extracting',
      progress: Math.round(capped * 100),
    };
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.currentKey) {
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
  }

  async download(id: QwenModelId): Promise<boolean> {
    if (isQwenModelInstalled(id)) return true;
    const spec = QWEN_MODELS[id];
    const destDir = getQwenModelDir(id);
    const tmp = path.join(getQwenModelsRoot(), spec.archiveName);
    const key = getQwenProgressKey(id);
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
    for (const url of spec.archiveUrls) {
      try {
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
        await this.downloadArchive(url, tmp);

        // 解包到独立进程（system tar），主进程事件循环不阻塞 → 不再「卡住」；
        // 失败回退 bundled decompress。strip 顶层目录、过滤 test_wavs。
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
        fs.rmSync(tmp, { force: true });

        if (!isQwenModelInstalled(id)) {
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
        logMessage(`qwen model ${id} installed from ${url}`, 'info');
        return true;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg === CANCELLED) {
          if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
          this.progress = { ...this.progress, status: 'idle' };
          this.sendFinal(key, 1);
          this.currentKey = null;
          throw error;
        }
        logMessage(`qwen model ${id} from ${url} failed: ${msg}`, 'warning');
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

  /** 并行续传下载整包；服务端不支持 Range 时回退单连接。 */
  private async downloadArchive(url: string, dest: string): Promise<void> {
    try {
      await downloadFileParallel({
        url,
        destPath: dest,
        signal: this.abortController?.signal,
        headers: { 'User-Agent': 'SmartSub-Electron' },
        onProgress: (downloaded, total) => this.update({ downloaded, total }),
        log: (m, l) => logMessage(m, l),
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
          response.on('data', (c: Buffer) => {
            downloaded += c.length;
            this.update({ downloaded, total });
          });
          const out = fs.createWriteStream(destPath, { flags: 'w' });
          response.pipe(out);
          out.on('finish', () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
          out.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(CONNECT_TIMEOUT);
    });
  }
}

let instance: QwenModelDownloader | null = null;

export function getQwenModelDownloader(
  mainWindow?: BrowserWindow,
): QwenModelDownloader {
  if (!instance) instance = new QwenModelDownloader(mainWindow);
  else if (mainWindow) instance.setMainWindow(mainWindow);
  return instance;
}
