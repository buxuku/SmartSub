import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import { store } from '../store';
import { resolveProxyEnv } from '../network/proxyEnv';
import type {
  DownloaderEngine,
  DownloadEntryMeta,
  DownloadQuality,
} from '../../../types/download';
import type { ParsedProgress } from './parsers';

export interface PreflightOptions {
  url: string;
  timeoutMs?: number;
}

export interface DownloadJobOptions {
  url: string;
  savePath: string;
  quality: DownloadQuality;
  /** 播放列表 URL 且用户确认整表下载（未展开条目的兜底路径） */
  expandPlaylist?: boolean;
  /** 预检元数据（lux 命名输出/进度估算依赖 title/totalBytes） */
  meta?: DownloadEntryMeta;
  onProgress: (p: ParsedProgress) => void;
  signal: AbortSignal;
}

export interface DownloadJobResult {
  /** 产出的媒体文件绝对路径（播放列表兜底路径可能多个） */
  outputPaths: string[];
}

/** 下载引擎适配器统一签名（yt-dlp / lux；后续 BBDown 等按此扩展） */
export interface DownloadEngineAdapter {
  readonly engine: DownloaderEngine;
  preflight(
    binaryPath: string,
    opts: PreflightOptions,
  ): Promise<DownloadEntryMeta>;
  download(
    binaryPath: string,
    opts: DownloadJobOptions,
  ): Promise<DownloadJobResult>;
}

/** 当前代理设置（--proxy 参数与子进程环境变量共用一个来源） */
export function getProxyUrl(): string {
  try {
    const settings = store.get('settings') as
      | Parameters<typeof resolveProxyEnv>[0]
      | undefined;
    return resolveProxyEnv(settings || {}).httpProxy || '';
  } catch {
    return '';
  }
}

/** 随包 ffmpeg 路径（yt-dlp --ffmpeg-location 与 lux PATH 注入共用） */
export function ffmpegLocation(): string {
  return (ffmpegStatic as unknown as string).replace(
    'app.asar',
    'app.asar.unpacked',
  );
}

/**
 * 子进程环境：透传代理（lux/Go 走环境变量）+ 稳定 UTF-8 输出。
 * 随包 ffmpeg 目录前置进 PATH——lux 合并 DASH 分离流（B站等）依赖 PATH 上的
 * ffmpeg，打包后的应用环境 PATH 里没有它，缺失时合并失败只留分片。
 */
export function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  };
  try {
    const ffmpegDir = path.dirname(ffmpegLocation());
    env.PATH = `${ffmpegDir}${path.delimiter}${env.PATH || ''}`;
  } catch {
    // ffmpeg-static 解析失败时保持原 PATH（yt-dlp 仍有显式 --ffmpeg-location）
  }
  const proxy = getProxyUrl();
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.http_proxy = proxy;
    env.https_proxy = proxy;
  } else {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
  }
  return env;
}

export interface RunProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const CANCELLED = 'Download cancelled';

/**
 * spawn 收敛：stdout/stderr 逐块回调 + 结束态 Promise。
 * signal 中止时 kill 进程并以 `Download cancelled` reject。
 */
export function runProcess(
  command: string,
  args: string[],
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {},
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: buildChildEnv(),
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error(CANCELLED)));
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill();
        reject(new Error(CANCELLED));
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        child.kill();
        finish(() =>
          reject(new Error(`Process timeout after ${opts.timeoutMs}ms`)),
        );
      }, opts.timeoutMs);
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      opts.onStderr?.(text);
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code) => {
      finish(() => resolve({ code, stdout, stderr }));
    });
  });
}

export function isCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === CANCELLED;
}
