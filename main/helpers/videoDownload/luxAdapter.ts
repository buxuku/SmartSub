import * as fs from 'fs';
import * as path from 'path';
import type { DownloadEntryMeta } from '../../../types/download';
import {
  isLuxPartFileName,
  parseLuxPreflightJson,
  parseLuxProgressChunk,
  tailForError,
} from './parsers';
import {
  runProcess,
  type DownloadEngineAdapter,
  type DownloadJobOptions,
  type DownloadJobResult,
  type PreflightOptions,
} from './engineAdapter';

const PREFLIGHT_TIMEOUT_MS = 45_000;
/** 进度文本解析不到时的文件大小轮询间隔 */
const SIZE_POLL_INTERVAL_MS = 1000;

/** 跨平台文件名清洗（lux -O 只接受纯文件名，不含扩展名） */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 文件名结尾的点/空格非法
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 120) || `video-${Date.now()}`;
}

/** 下载前对目录快照，完成后 diff 出新增媒体文件（lux 不回报输出路径） */
function snapshotDir(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

const MEDIA_EXT = /\.(mp4|mkv|webm|flv|mov|ts|m4a|mp3|aac|wav)$/i;
const TEMP_EXT = /\.(download|part|tmp)$/i;

export interface LuxOutputScan {
  outputs: string[];
  /** 只剩分片没有成品：ffmpeg 合并失败的特征 */
  partsOnly: boolean;
}

/**
 * 产物认领：
 * - baseName 已知（-O 指定命名）→ 精确前缀匹配，允许命中「已存在」的同名成品
 *   （重试/重复下载时 lux 因文件已存在跳过下载直接退出，diff 为空但文件就是产物）；
 * - baseName 未知（lux 按标题自行命名）→ 目录 diff 出的新增成品。
 * 两种模式都排除 `[N]` 分片中间产物。
 */
function scanOutputs(
  dir: string,
  before: Set<string>,
  baseName: string | null,
): LuxOutputScan {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { outputs: [], partsOnly: false };
  }
  const media = entries.filter(
    (name) => MEDIA_EXT.test(name) && !TEMP_EXT.test(name),
  );
  if (baseName) {
    const exact = media.filter(
      (name) => name.startsWith(baseName) && !isLuxPartFileName(name, baseName),
    );
    if (exact.length) {
      return {
        outputs: exact.map((name) => path.join(dir, name)),
        partsOnly: false,
      };
    }
  }
  const fresh = media.filter(
    (name) => !before.has(name) && !isLuxPartFileName(name, baseName),
  );
  if (fresh.length) {
    return {
      outputs: fresh.map((name) => path.join(dir, name)),
      partsOnly: false,
    };
  }
  const hasParts = media.some(
    (name) => !before.has(name) && isLuxPartFileName(name, baseName),
  );
  return { outputs: [], partsOnly: hasParts };
}

export const luxAdapter: DownloadEngineAdapter = {
  engine: 'lux',

  async preflight(
    binaryPath: string,
    opts: PreflightOptions,
  ): Promise<DownloadEntryMeta> {
    const result = await runProcess(binaryPath, ['-j', opts.url], {
      timeoutMs: opts.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(tailForError(result.stderr || result.stdout));
    }
    return parseLuxPreflightJson(result.stdout);
  },

  async download(
    binaryPath: string,
    opts: DownloadJobOptions,
  ): Promise<DownloadJobResult> {
    // 命名策略：仅在有真实标题且非播放列表时用 -O 指定（确定性认领产物）。
    // 没有标题时绝不用域名等占位——让 lux 按它提取的视频标题自行命名，
    // 否则同域名批量下载会全部撞名（lux 同名跳过 → 认领错文件）。
    // 播放列表（-p）多条产物也不可共用一个 -O 名。
    const title = opts.meta?.title?.trim();
    const baseName =
      title && !opts.expandPlaylist ? sanitizeFileName(title) : null;
    const before = snapshotDir(opts.savePath);
    const totalBytes = opts.meta?.totalBytes || 0;

    let sawParsableProgress = false;
    // 降级路径：进度文本解析不到时按「输出目录新增字节 / 预检总大小」估算
    const poller = setInterval(() => {
      if (sawParsableProgress || totalBytes <= 0) return;
      try {
        const entries = fs.readdirSync(opts.savePath);
        let bytes = 0;
        for (const name of entries) {
          // 计入：我们命名的文件（含分片/临时）或目录新增文件
          const claimed = baseName ? name.startsWith(baseName) : false;
          const fresh = !before.has(name);
          if (!claimed && !fresh) continue;
          try {
            bytes += fs.statSync(path.join(opts.savePath, name)).size;
          } catch {
            // 下载中文件可能瞬时不可读
          }
        }
        if (bytes > 0) {
          opts.onProgress({
            progress: Math.min((bytes / totalBytes) * 100, 99),
          });
        }
      } catch {
        // 目录不可读时静默，等下一轮
      }
    }, SIZE_POLL_INTERVAL_MS);

    try {
      const args = [
        '-o',
        opts.savePath,
        ...(baseName ? ['-O', baseName] : []),
        ...(opts.expandPlaylist ? ['-p'] : []),
        opts.url,
      ];
      const result = await runProcess(binaryPath, args, {
        signal: opts.signal,
        onStdout: (chunk) => {
          const progress = parseLuxProgressChunk(chunk);
          if (progress) {
            sawParsableProgress = true;
            opts.onProgress(progress);
          }
        },
      });
      const scan = scanOutputs(opts.savePath, before, baseName);
      const mergeFailedError =
        'lux downloaded DASH parts but failed to merge them (ffmpeg unavailable in child PATH?)';
      if (result.code !== 0) {
        // 合并失败特征（只剩 [N] 分片）：给出可操作的明确原因，而非 Go 堆栈
        throw new Error(
          scan.partsOnly
            ? mergeFailedError
            : tailForError(result.stderr || result.stdout),
        );
      }
      if (scan.outputs.length === 0) {
        // 正常退出却无成品：把 lux 自己的输出带出来，避免真实原因被吞掉
        const detail = tailForError(result.stdout || result.stderr);
        throw new Error(
          scan.partsOnly
            ? mergeFailedError
            : `lux finished without producing output file${detail ? `: ${detail}` : ''}`,
        );
      }
      return { outputPaths: scan.outputs };
    } finally {
      clearInterval(poller);
    }
  },
};
