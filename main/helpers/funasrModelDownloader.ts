import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { logMessage } from './storeManager';
import type { ModelDownloadProgress } from './modelDownloader';
import {
  FUNASR_MODELS,
  FunasrModelId,
  getFunasrModelDir,
  isFunasrModelInstalled,
} from './funasrModelCatalog';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from './download/parallelDownloader';

interface HfTreeEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

const CONNECT_TIMEOUT = 30_000;

/** 进度 key：funasr:<modelId>，与 ct2:<id> 同构，渲染层按前缀路由。 */
export function getFunasrProgressKey(id: FunasrModelId): string {
  return `funasr:${id}`;
}

/** 镜像优先：hf-mirror.com（国内快）→ huggingface.co。 */
function getHosts(source?: string): string[] {
  if (source === 'huggingface') return ['huggingface.co', 'hf-mirror.com'];
  return ['hf-mirror.com', 'huggingface.co'];
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).href;
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
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(CONNECT_TIMEOUT);
  });
}

export class FunasrModelDownloader {
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

  async download(id: FunasrModelId, source?: string): Promise<boolean> {
    if (isFunasrModelInstalled(id)) return true;
    const spec = FUNASR_MODELS[id];
    const destDir = getFunasrModelDir(id);
    const key = getFunasrProgressKey(id);
    this.currentKey = key;
    this.abortController = new AbortController();

    // files 模式（silero-vad）：按候选 URL 顺序下单个小文件。
    if (spec.files && spec.files.length > 0) {
      return this.downloadFilesMode(id, spec, destDir, key);
    }

    let lastError: unknown = null;
    for (const host of getHosts(source)) {
      try {
        const info = await fetchJson<{ sha?: string }>(
          `https://${host}/api/models/${spec.repo}`,
        );
        const revision = info.sha || 'main';
        const tree = await fetchJson<HfTreeEntry[]>(
          `https://${host}/api/models/${spec.repo}/tree/${revision}?recursive=true`,
        );
        const files = tree.filter(
          (e) =>
            e.type === 'file' &&
            e.path &&
            !e.path.startsWith('.') &&
            (e.size ?? 0) > 0 &&
            (!spec.keepFiles || spec.keepFiles.includes(e.path)),
        );
        if (files.length === 0) throw new Error('empty tree');

        const total = files.reduce((s, f) => s + (f.size ?? 0), 0);
        let downloaded = 0;
        this.update({
          status: 'downloading',
          downloaded: 0,
          total,
          progress: 0,
          error: undefined,
        });

        for (const f of files) {
          const dest = path.join(destDir, f.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (
            fs.existsSync(dest) &&
            fs.statSync(dest).size === (f.size ?? -1)
          ) {
            downloaded += f.size ?? 0;
            this.update({ downloaded });
            continue;
          }
          const url = `https://${host}/${spec.repo}/resolve/${revision}/${f.path}`;
          try {
            await downloadFileParallel({
              url,
              destPath: dest,
              signal: this.abortController?.signal,
              headers: { 'User-Agent': 'SmartSub-Electron' },
              onProgress: (thisFile) =>
                this.update({ downloaded: downloaded + thisFile, total }),
              log: (m, l) => logMessage(m, l),
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg === 'Download cancelled') throw error;
            if (error instanceof RangeNotSupportedError) {
              await this.downloadSingle(
                url,
                dest,
                this.abortController?.signal,
              );
            } else {
              throw error;
            }
          }
          downloaded += f.size ?? 0;
          this.update({ downloaded });
        }

        // 全部下完后校验关键文件齐全。
        if (!isFunasrModelInstalled(id)) {
          throw new Error(
            `download finished but required files missing for ${id}: ${spec.requiredFiles.join(', ')}`,
          );
        }
        this.progress = {
          ...this.progress,
          status: 'completed',
          progress: 100,
          downloaded: total,
          total,
        };
        this.sendFinal(key, 1);
        this.currentKey = null;
        logMessage(`funasr model ${id} downloaded from ${host}`, 'info');
        return true;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg === 'Download cancelled') {
          this.progress = { ...this.progress, status: 'idle' };
          this.sendFinal(key, 1);
          this.currentKey = null;
          throw error;
        }
        logMessage(`funasr model ${id} from ${host} failed: ${msg}`, 'warning');
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

  /** files 模式：逐文件按候选 URL 顺序回退下载（用于 silero_vad.onnx 这类单文件）。 */
  private async downloadFilesMode(
    id: FunasrModelId,
    spec: (typeof FUNASR_MODELS)[FunasrModelId],
    destDir: string,
    key: string,
  ): Promise<boolean> {
    this.update({
      status: 'downloading',
      downloaded: 0,
      total: 0,
      progress: 0,
      error: undefined,
    });
    for (const f of spec.files || []) {
      const dest = path.join(destDir, f.name);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
      let ok = false;
      let lastError: unknown = null;
      for (const url of f.urls) {
        try {
          await downloadFileParallel({
            url,
            destPath: dest,
            signal: this.abortController?.signal,
            headers: { 'User-Agent': 'SmartSub-Electron' },
            onProgress: (thisFile, totalFile) =>
              this.update({ downloaded: thisFile, total: totalFile || 0 }),
            log: (m, l) => logMessage(m, l),
          });
          ok = true;
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg === 'Download cancelled') {
            this.progress = { ...this.progress, status: 'idle' };
            this.sendFinal(key, 1);
            this.currentKey = null;
            throw error;
          }
          if (error instanceof RangeNotSupportedError) {
            try {
              await this.downloadSingle(
                url,
                dest,
                this.abortController?.signal,
              );
              ok = true;
              break;
            } catch (e2) {
              lastError = e2;
            }
          } else {
            lastError = error;
          }
          logMessage(
            `funasr ${id} file ${f.name} from ${url} failed: ${msg}`,
            'warning',
          );
        }
      }
      if (!ok) {
        this.progress = {
          ...this.progress,
          status: 'error',
          error:
            lastError instanceof Error ? lastError.message : String(lastError),
        };
        this.sendFinal(key, 0);
        this.currentKey = null;
        throw lastError instanceof Error
          ? lastError
          : new Error(String(lastError));
      }
    }
    if (!isFunasrModelInstalled(id)) {
      throw new Error(`download finished but required files missing for ${id}`);
    }
    this.progress = { ...this.progress, status: 'completed', progress: 100 };
    this.sendFinal(key, 1);
    this.currentKey = null;
    logMessage(`funasr model ${id} downloaded (files mode)`, 'info');
    return true;
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
        reject(new Error('Download cancelled'));
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

let instance: FunasrModelDownloader | null = null;

export function getFunasrModelDownloader(
  mainWindow?: BrowserWindow,
): FunasrModelDownloader {
  if (!instance) instance = new FunasrModelDownloader(mainWindow);
  else if (mainWindow) instance.setMainWindow(mainWindow);
  return instance;
}
