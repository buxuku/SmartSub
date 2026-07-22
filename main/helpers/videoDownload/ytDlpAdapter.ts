import * as fs from 'fs';
import * as path from 'path';
import type {
  DownloadEntryMeta,
  DownloadQuality,
} from '../../../types/download';
import {
  claimSubtitleFileNames,
  parseYtDlpPreflightJson,
  parseYtDlpProgressLine,
  tailForError,
  YTDLP_PROGRESS_TEMPLATE,
} from './parsers';
import {
  ffmpegLocation,
  getProxyUrl,
  runProcess,
  type DownloadEngineAdapter,
  type DownloadJobOptions,
  type DownloadJobResult,
  type PreflightOptions,
} from './engineAdapter';

const PREFLIGHT_TIMEOUT_MS = 45_000;

/** 输出模板：标题 + 站点 id 保证唯一性；扩展名交给引擎（合流后可能变化） */
const OUTPUT_TEMPLATE = '%(title)s [%(id)s].%(ext)s';

/** 最终文件路径打印哨兵（--print after_move:filepath 输出行前缀） */
const FILEPATH_PREFIX = 'SMARTSUB-FILE;';

function qualityArgs(quality: DownloadQuality): string[] {
  // -S res:N 为「偏好排序」：不满足档位时就近降档而非报错
  if (quality === '1080p') return ['-S', 'res:1080'];
  if (quality === '720p') return ['-S', 'res:720'];
  return [];
}

function commonArgs(): string[] {
  const args = ['--no-warnings', '--newline'];
  const proxy = getProxyUrl();
  if (proxy) args.push('--proxy', proxy);
  return args;
}

/**
 * 按视频最终路径认领同目录的字幕文件（--write-subs 产物：`主干.lang.srt`）。
 * 扫描失败不阻断下载结果（字幕是增益产物）。
 */
async function scanSubtitleFiles(videoPaths: string[]): Promise<string[]> {
  const claimed: string[] = [];
  const dirCache = new Map<string, string[]>();
  for (const videoPath of videoPaths) {
    const dir = path.dirname(videoPath);
    try {
      let names = dirCache.get(dir);
      if (!names) {
        names = await fs.promises.readdir(dir);
        dirCache.set(dir, names);
      }
      for (const name of claimSubtitleFileNames(
        path.basename(videoPath),
        names,
      )) {
        const full = path.join(dir, name);
        if (!claimed.includes(full)) claimed.push(full);
      }
    } catch {
      // 目录读取失败：跳过该视频的字幕认领
    }
  }
  return claimed;
}

export const ytDlpAdapter: DownloadEngineAdapter = {
  engine: 'yt-dlp',

  async preflight(
    binaryPath: string,
    opts: PreflightOptions,
  ): Promise<DownloadEntryMeta> {
    const args = [
      ...commonArgs(),
      ...(opts.cookieFilePath ? ['--cookies', opts.cookieFilePath] : []),
      '-J',
      '--flat-playlist',
      '--',
      opts.url,
    ];
    const result = await runProcess(binaryPath, args, {
      timeoutMs: opts.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(tailForError(result.stderr || result.stdout));
    }
    return parseYtDlpPreflightJson(result.stdout);
  },

  async download(
    binaryPath: string,
    opts: DownloadJobOptions,
  ): Promise<DownloadJobResult> {
    const args = [
      ...commonArgs(),
      ...(opts.cookieFilePath ? ['--cookies', opts.cookieFilePath] : []),
      '-c',
      '-P',
      opts.savePath,
      '-o',
      OUTPUT_TEMPLATE,
      '--ffmpeg-location',
      ffmpegLocation(),
      '--progress-template',
      `download:${YTDLP_PROGRESS_TEMPLATE}`,
      // --print 默认蕴含 simulate，必须显式关闭；after_move 才是合流/移动后的最终路径
      '--no-simulate',
      '--print',
      `after_move:${FILEPATH_PREFIX}%(filepath)s`,
      ...qualityArgs(opts.quality),
      // 官方字幕直取：仅人工字幕（不开 --write-auto-subs），统一转 srt
      // （依赖已注入的 --ffmpeg-location；转换失败 yt-dlp 保留原格式）
      ...(opts.writeSubs ? ['--write-subs', '--convert-subs', 'srt'] : []),
      opts.expandPlaylist ? '--yes-playlist' : '--no-playlist',
      '--',
      opts.url,
    ];

    const outputPaths: string[] = [];
    let lineBuffer = '';
    const handleStdout = (chunk: string) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const fileIdx = line.indexOf(FILEPATH_PREFIX);
        if (fileIdx >= 0) {
          const filePath = line.slice(fileIdx + FILEPATH_PREFIX.length).trim();
          if (filePath) outputPaths.push(filePath);
          continue;
        }
        const progress = parseYtDlpProgressLine(line);
        if (progress) opts.onProgress(progress);
      }
    };

    const result = await runProcess(binaryPath, args, {
      signal: opts.signal,
      onStdout: handleStdout,
    });
    // flush 余留半行（进程结束时最后一行可能无换行）
    if (lineBuffer) handleStdout('\n');

    if (result.code !== 0) {
      throw new Error(tailForError(result.stderr || result.stdout));
    }
    if (outputPaths.length === 0) {
      throw new Error('yt-dlp finished without reporting output file');
    }
    if (!opts.writeSubs) return { outputPaths };
    const subtitlePaths = await scanSubtitleFiles(outputPaths);
    return {
      outputPaths,
      ...(subtitlePaths.length ? { subtitlePaths } : {}),
    };
  },
};
