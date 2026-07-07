import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { logMessage } from './storeManager';
import type { ModelDownloadProgress } from './modelDownloader';
import {
  TTS_MODELS,
  TtsModelId,
  TtsModelSource,
  TtsModelSpec,
  TTS_DEFAULT_SOURCE,
  getTtsSourceOrder,
  getTtsArchiveUrl,
  getTtsModelDir,
  getTtsModelsRoot,
  isTtsModelInstalled,
} from './ttsModelCatalog';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from './download/parallelDownloader';
import { extractArchive } from './download/extractArchive';

const CONNECT_TIMEOUT = 30_000;
const CANCELLED = 'Download cancelled';

/** 进度 key：tts:<modelId>，与 qwen:<id> / funasr:<id> 同构，渲染层按前缀路由。 */
export function getTtsProgressKey(id: TtsModelId): string {
  return `tts:${id}`;
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).href;
}

/**
 * TTS 模型下载器：GitHub release tar.bz2 整包下载 + 解包到 userData/models/tts/<id>/。
 * 与 QwenModelDownloader 同构（同事件 downloadProgress / modelDownloadDetail），
 * 但源只有 ghproxy → github（kokoro/vits 无 ModelScope 镜像，HF 镜像 401）。
 */
export class TtsModelDownloader {
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

  /** 解包阶段进度：复用 downloadProgress 让进度条继续走，status='extracting' 供 UI 显示。 */
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

  async download(
    id: TtsModelId,
    source: TtsModelSource = TTS_DEFAULT_SOURCE,
  ): Promise<boolean> {
    if (isTtsModelInstalled(id)) return true;
    const spec = TTS_MODELS[id];
    const key = getTtsProgressKey(id);
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
    for (const src of getTtsSourceOrder(source)) {
      try {
        await this.downloadFromArchive(spec, src);
        if (!isTtsModelInstalled(id)) {
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
        logMessage(`tts model ${id} installed from ${src}`, 'info');
        return true;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg === CANCELLED) {
          this.progress = { ...this.progress, status: 'idle' };
          this.sendFinal(key, 1);
          this.currentKey = null;
          throw error;
        }
        logMessage(`tts model ${id} from ${src} failed: ${msg}`, 'warning');
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

  /** 整包源：下载 tar.bz2 → 解包到模型目录（独立进程 system tar，失败回退 decompress）。 */
  private async downloadFromArchive(
    spec: TtsModelSpec,
    source: TtsModelSource,
  ): Promise<void> {
    const destDir = getTtsModelDir(spec.id);
    const tmp = path.join(getTtsModelsRoot(), spec.archiveName);
    const url = getTtsArchiveUrl(spec, source);

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
        approxTotalBytes: spec.approxInstallBytes,
        signal: this.abortController?.signal,
        onProgress: (ratio) => this.sendExtract(ratio),
      });
    } finally {
      // 无论成功/失败/取消都清理临时整包，避免污染 models 根目录。
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    }
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

let instance: TtsModelDownloader | null = null;

export function getTtsModelDownloader(
  mainWindow?: BrowserWindow,
): TtsModelDownloader {
  if (!instance) instance = new TtsModelDownloader(mainWindow);
  else if (mainWindow) instance.setMainWindow(mainWindow);
  return instance;
}
