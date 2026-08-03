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
  QwenModelSource,
  QwenModelSpec,
  QWEN_DEFAULT_SOURCE,
  getQwenSourceOrder,
  getQwenSupportedSources,
  getQwenArchiveUrl,
  getQwenModelScopeFileUrl,
  getQwenModelScopeTreeUrl,
  getQwenModelDir,
  getQwenModelsRoot,
  isQwenModelInstalled,
} from './qwenModelCatalog';
import {
  downloadFileParallel,
  RangeNotSupportedError,
} from './download/parallelDownloader';
import { extractArchive } from './download/extractArchive';
import { assertFileSize } from './download/resumeIntegrity';
import { fetchJson } from './download/fetchJson';

const CONNECT_TIMEOUT = 30_000;
const CANCELLED = 'Download cancelled';
const MAX_REDIRECTS = 5;

/** 进度 key：qwen:<modelId>，与 funasr:<id> / ct2:<id> 同构，渲染层按前缀路由。 */
export function getQwenProgressKey(id: QwenModelId): string {
  return `qwen:${id}`;
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).href;
}

/** ModelScope 文件树条目（仅取所需字段）。 */
interface MsFileEntry {
  Path: string;
  Size: number;
  Type: string;
}

interface QwenDownloadSession {
  key: string;
  controller: AbortController;
}

/**
 * Qwen 模型下载器：
 * - ModelScope 按 catalog 逐文件下载（所有规格可用）；
 * - 有 sherpa-onnx release 整包的规格可经 GitHub / ghproxy 下载并解包。
 * 复用 downloadFileParallel（多连接 + 取消），与 FunasrModelDownloader 使用相同进度事件。
 */
export class QwenModelDownloader {
  private activeSession: QwenDownloadSession | null = null;
  private mainWindow: BrowserWindow | null = null;
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
    const session = this.activeSession;
    if (session && !session.controller.signal.aborted) {
      session.controller.abort();
      this.progress = { ...this.progress, status: 'idle' };
      this.send(session);
    }
  }

  private send(session: QwenDownloadSession): void {
    if (
      this.activeSession === session &&
      this.mainWindow &&
      !this.mainWindow.isDestroyed()
    ) {
      const ratio =
        this.progress.total > 0
          ? this.progress.downloaded / this.progress.total
          : 0;
      this.mainWindow.webContents.send(
        'downloadProgress',
        session.key,
        Math.min(ratio, 0.99),
      );
      this.mainWindow.webContents.send(
        'modelDownloadDetail',
        session.key,
        this.progress,
      );
    }
  }

  private update(
    session: QwenDownloadSession,
    p: Partial<ModelDownloadProgress>,
  ): void {
    if (this.activeSession !== session) return;
    this.progress = { ...this.progress, ...p };
    if (this.progress.total > 0) {
      this.progress.progress =
        (this.progress.downloaded / this.progress.total) * 100;
    }
    this.send(session);
  }

  private sendFinal(session: QwenDownloadSession, value: number): void {
    if (
      this.activeSession === session &&
      this.mainWindow &&
      !this.mainWindow.isDestroyed()
    ) {
      this.mainWindow.webContents.send('downloadProgress', session.key, value);
      this.mainWindow.webContents.send(
        'modelDownloadDetail',
        session.key,
        this.progress,
      );
    }
  }

  /** 解包阶段进度：复用 downloadProgress 让进度条继续走，status='extracting' 供 UI 显示「解包中」。 */
  private sendExtract(session: QwenDownloadSession, ratio: number): void {
    if (this.activeSession !== session) return;
    const capped = Math.min(ratio, 0.99);
    this.progress = {
      ...this.progress,
      status: 'extracting',
      progress: Math.round(capped * 100),
    };
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('downloadProgress', session.key, capped);
      this.mainWindow.webContents.send(
        'modelDownloadDetail',
        session.key,
        this.progress,
      );
    }
  }

  async download(
    id: QwenModelId,
    source: QwenModelSource = QWEN_DEFAULT_SOURCE,
  ): Promise<boolean> {
    if (this.activeSession) {
      throw new Error('another qwen model download is in progress');
    }
    if (isQwenModelInstalled(id)) return true;
    const spec = QWEN_MODELS[id];
    const session: QwenDownloadSession = {
      key: getQwenProgressKey(id),
      controller: new AbortController(),
    };
    this.activeSession = session;

    this.update(session, {
      status: 'downloading',
      downloaded: 0,
      total: 0,
      progress: 0,
      error: undefined,
    });

    try {
      let lastError: unknown = null;
      // 按所选源优先、其余按国内优先顺序回退（modelscope → ghproxy → github）。
      for (const src of getQwenSourceOrder(
        source,
        getQwenSupportedSources(id),
      )) {
        try {
          if (session.controller.signal.aborted) {
            throw new Error(CANCELLED);
          }
          if (src === 'modelscope') {
            await this.downloadFromModelScope(spec, session);
          } else {
            await this.downloadFromArchive(spec, src, session);
          }

          if (!isQwenModelInstalled(id)) {
            throw new Error(
              `download finished but required files are incomplete or wrong-sized for ${id}: ${spec.requiredFiles.join(', ')}`,
            );
          }
          this.progress = {
            ...this.progress,
            status: 'completed',
            progress: 100,
          };
          this.sendFinal(session, 1);
          logMessage(`qwen model ${id} installed from ${src}`, 'info');
          return true;
        } catch (error) {
          lastError = error;
          const msg = error instanceof Error ? error.message : String(error);
          if (session.controller.signal.aborted || msg === CANCELLED) {
            this.progress = { ...this.progress, status: 'idle' };
            this.sendFinal(session, 0);
            throw new Error(CANCELLED);
          }
          logMessage(`qwen model ${id} from ${src} failed: ${msg}`, 'warning');
        }
      }

      this.progress = {
        ...this.progress,
        status: 'error',
        error:
          lastError instanceof Error ? lastError.message : String(lastError),
      };
      this.sendFinal(session, 0);
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
    } finally {
      if (this.activeSession === session) {
        this.activeSession = null;
      }
    }
  }

  /**
   * ModelScope 国内源：逐文件直下到模型目录，免解包（国内 CDN 最快）。
   * 文件大小固定在 catalog revision；文件树用于交叉校验远端元数据。
   * 已存在且大小吻合的文件跳过（续传友好）。
   */
  private async downloadFromModelScope(
    spec: QwenModelSpec,
    session: QwenDownloadSession,
  ): Promise<void> {
    const destDir = getQwenModelDir(spec.id);
    const signal = session.controller.signal;

    let sizeByPath = new Map<string, number>();
    try {
      const tree = await fetchJson<{ Data?: { Files?: MsFileEntry[] } }>(
        getQwenModelScopeTreeUrl(spec),
        {
          signal,
          headers: { 'User-Agent': 'SmartSub-Electron' },
          timeoutMs: CONNECT_TIMEOUT,
          cancelMessage: CANCELLED,
        },
      );
      sizeByPath = new Map(
        (tree.Data?.Files ?? [])
          .filter((e) => e.Type === 'blob')
          .map((e) => [e.Path, e.Size ?? 0]),
      );
    } catch (e) {
      if (signal.aborted) throw new Error(CANCELLED);
      // 树拉取失败不阻断固定 revision 的逐文件下载；进度仍使用 catalog 大小。
      logMessage(`qwen modelscope tree fetch failed: ${String(e)}`, 'warning');
    }

    for (const file of spec.modelScopeFiles) {
      const remoteSize = sizeByPath.get(file.remote);
      if (remoteSize !== undefined && remoteSize !== file.size) {
        throw new Error(
          `qwen catalog size mismatch for ${file.remote}: remote ${remoteSize}, expected ${file.size}`,
        );
      }
    }

    const files = spec.modelScopeFiles;
    const total = files.reduce((s, f) => s + f.size, 0);
    let downloaded = 0;
    this.update(session, {
      status: 'downloading',
      downloaded: 0,
      total,
      progress: 0,
      error: undefined,
    });

    for (const f of files) {
      if (signal.aborted) throw new Error(CANCELLED);
      const dest = path.join(destDir, f.local);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) {
        downloaded += f.size;
        this.update(session, { downloaded });
        continue;
      }
      const url = getQwenModelScopeFileUrl(spec, f.remote);
      try {
        await downloadFileParallel({
          url,
          destPath: dest,
          signal,
          headers: { 'User-Agent': 'SmartSub-Electron' },
          onProgress: (thisFile) =>
            this.update(session, {
              downloaded: downloaded + thisFile,
              total,
            }),
          log: (m, l) => logMessage(m, l),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (signal.aborted || msg === CANCELLED) {
          throw new Error(CANCELLED);
        }
        if (error instanceof RangeNotSupportedError) {
          await this.downloadSingle(url, dest, signal, (thisFile) =>
            this.update(session, {
              downloaded: downloaded + thisFile,
              total,
            }),
          );
        } else {
          throw error;
        }
      }
      assertFileSize(dest, f.size, `${spec.id}/${f.local}`);
      downloaded += f.size;
      this.update(session, { downloaded });
    }
  }

  /** 整包源（ghproxy/github）：下载 tar.bz2 → 解包到模型目录（独立进程 system tar）。 */
  private async downloadFromArchive(
    spec: QwenModelSpec,
    source: 'ghproxy' | 'github',
    session: QwenDownloadSession,
  ): Promise<void> {
    if (!spec.archiveName) {
      throw new Error(`archive source is unavailable for ${spec.id}`);
    }
    const destDir = getQwenModelDir(spec.id);
    const tmp = path.join(getQwenModelsRoot(), spec.archiveName);
    const url = getQwenArchiveUrl(spec, source);
    if (!url) {
      throw new Error(`archive source is unavailable for ${spec.id}`);
    }

    this.update(session, {
      status: 'downloading',
      downloaded: 0,
      total: 0,
      progress: 0,
      error: undefined,
    });

    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
      await this.downloadArchive(url, tmp, session);

      // 解包到独立进程（system tar），主进程事件循环不阻塞 → 不再「卡住」；
      // 失败回退 bundled decompress。strip 顶层目录、过滤 test_wavs。
      this.progress = { ...this.progress, status: 'extracting' };
      this.sendExtract(session, 0);
      await extractArchive({
        archivePath: tmp,
        destDir,
        strip: 1,
        excludeContains: 'test_wavs',
        approxTotalBytes: spec.approxInstallBytes,
        signal: session.controller.signal,
        onProgress: (ratio) => this.sendExtract(session, ratio),
      });
    } finally {
      // 无论成功/失败/取消都清理临时整包，避免污染 models 根目录。
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    }
  }

  /** 并行续传下载整包；服务端不支持 Range 时回退单连接。 */
  private async downloadArchive(
    url: string,
    dest: string,
    session: QwenDownloadSession,
  ): Promise<void> {
    const signal = session.controller.signal;
    try {
      await downloadFileParallel({
        url,
        destPath: dest,
        signal,
        headers: { 'User-Agent': 'SmartSub-Electron' },
        onProgress: (downloaded, total) =>
          this.update(session, { downloaded, total }),
        log: (m, l) => logMessage(m, l),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (signal.aborted || msg === CANCELLED) {
        throw new Error(CANCELLED);
      }
      if (error instanceof RangeNotSupportedError) {
        await this.downloadSingle(url, dest, signal, (downloaded, total) =>
          this.update(session, { downloaded, total }),
        );
        return;
      }
      throw error;
    }
  }

  private async downloadSingle(
    url: string,
    destPath: string,
    signal?: AbortSignal,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<void> {
    const working = `${destPath}.single`;
    await fs.promises.rm(working, { force: true });
    try {
      await this.downloadSingleRequest(url, working, signal, onProgress, 0);
      if (signal?.aborted) throw new Error(CANCELLED);
      await fs.promises.rm(destPath, { force: true });
      await fs.promises.rename(working, destPath);
    } finally {
      await fs.promises.rm(working, { force: true }).catch(() => {});
    }
  }

  private downloadSingleRequest(
    url: string,
    workingPath: string,
    signal: AbortSignal | undefined,
    onProgress: ((downloaded: number, total: number) => void) | undefined,
    redirects: number,
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error(CANCELLED));

    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const protocol = parsed.protocol === 'https:' ? https : http;
      let settled = false;
      let response: http.IncomingMessage | null = null;
      let out: fs.WriteStream | null = null;
      let req: http.ClientRequest;

      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          response?.destroy();
          out?.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve();
        }
      };
      const onAbort = () => {
        const error = new Error(CANCELLED);
        req.destroy(error);
        finish(error);
      };
      req = protocol.get(
        url,
        { headers: { 'User-Agent': 'SmartSub-Electron' } },
        (incoming) => {
          response = incoming;
          if (
            incoming.statusCode &&
            incoming.statusCode >= 300 &&
            incoming.statusCode < 400 &&
            incoming.headers.location
          ) {
            incoming.resume();
            if (redirects >= MAX_REDIRECTS) {
              finish(new Error('Too many redirects while downloading'));
              return;
            }
            settled = true;
            cleanup();
            this.downloadSingleRequest(
              resolveRedirectUrl(url, incoming.headers.location),
              workingPath,
              signal,
              onProgress,
              redirects + 1,
            ).then(resolve, reject);
            return;
          }
          if (
            !incoming.statusCode ||
            incoming.statusCode < 200 ||
            incoming.statusCode >= 300
          ) {
            incoming.resume();
            finish(new Error(`HTTP Error: ${incoming.statusCode}`));
            return;
          }

          const total = Number(incoming.headers['content-length'] || 0);
          let downloaded = 0;
          let streamFinished = false;
          incoming.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            onProgress?.(downloaded, total);
          });
          incoming.on('aborted', () =>
            finish(new Error('download response aborted before completion')),
          );
          incoming.on('error', finish);

          out = fs.createWriteStream(workingPath, { flags: 'w' });
          incoming.pipe(out);
          out.on('finish', () => {
            if (total > 0 && downloaded !== total) {
              finish(
                new Error(
                  `single download size mismatch: got ${downloaded}, expected ${total}`,
                ),
              );
              return;
            }
            streamFinished = true;
          });
          out.on('close', () => {
            if (streamFinished) finish();
            else if (!settled) {
              finish(new Error('download stream closed before completion'));
            }
          });
          out.on('error', finish);
        },
      );
      req.on('error', finish);
      req.setTimeout(CONNECT_TIMEOUT, () => {
        req.destroy(new Error('download request timeout'));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
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
