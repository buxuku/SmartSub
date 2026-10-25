/**
 * 视频极速裁剪服务
 *
 * 支持无损流拷贝（Lossless Stream Copy）与精确重新编码（Accurate Re-encode）两种模式；
 * 使用应用内置的 ffmpeg-static 二进制，无需系统 ffprobe 依赖；
 * 支持毫秒级入出点、任务取消与进度回调。
 */

import fs from 'fs';
import { reserveToolboxOutput, toolboxOutputDirectory } from './outputPath';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logMessage } from '../logger';
import { writableComposeExtension } from '../../../types/composeContainer';
import type { EmbeddedSubtitleStream } from '../embeddedSubtitleParser';
import { scanEmbeddedSubtitles } from './embeddedSubtitleExtractor';
import { buildSubtitleCodecOptions } from '../mediaStreamCompatibility';
import {
  COMPATIBLE_PIXEL_FORMAT,
  EVEN_DIMENSIONS_PAD_FILTER,
} from '../videoEncoding';
import type {
  VideoTrimConfig,
  VideoTrimProgress,
  VideoTrimResult,
} from '../../../types/toolbox';

const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

/** 正在执行的裁剪进程映射：jobId -> ChildProcess */
const activeTrimProcesses = new Map<string, ChildProcess>();
const preparingTrimJobs = new Map<string, AbortController>();

/** 取消指定裁剪任务 */
export function cancelVideoTrim(jobId: string): boolean {
  const preparing = preparingTrimJobs.get(jobId);
  if (preparing) {
    preparing.abort();
    return true;
  }
  const proc = activeTrimProcesses.get(jobId);
  if (proc) {
    try {
      proc.kill('SIGKILL');
      activeTrimProcesses.delete(jobId);
      logMessage(`已终止视频裁剪进程: ${jobId}`, 'info');
      return true;
    } catch (err) {
      logMessage(`终止视频裁剪进程异常: ${err}`, 'warning');
    }
  }
  return false;
}

/** 取消并清理所有正在进行的裁剪任务（在应用关闭时调用） */
export function cancelAllTrimProcesses(): void {
  preparingTrimJobs.forEach((controller) => controller.abort());
  for (const [jobId, proc] of activeTrimProcesses.entries()) {
    try {
      proc.kill('SIGKILL');
      logMessage(`关闭应用: 已清理裁剪子进程 ${jobId}`, 'info');
    } catch {}
  }
  activeTrimProcesses.clear();
}

/**
 * 时间标记 "00:01:23.45" 转换为秒数
 */
function parseTimemark(timemark: string): number {
  const match = /(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(timemark);
  if (!match) return 0;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const ms = match[4] ? parseFloat(`0.${match[4]}`) : 0;
  return h * 3600 + m * 60 + s + ms;
}

/**
 * 格式化秒数为 FFmpeg 时间格式 00:00:00.000
 */
export function formatFfmpegTime(seconds: number): string {
  const safeSec = Math.max(0, seconds);
  const h = Math.floor(safeSec / 3600);
  const m = Math.floor((safeSec % 3600) / 60);
  const s = Math.floor(safeSec % 60);
  const ms = Math.floor((safeSec % 1) * 1000);

  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * 探测视频信息（不依赖外部 ffprobe）
 */
export function probeVideoInfo(
  videoPath: string,
  signal?: AbortSignal,
  options: { allowUnknownDuration?: boolean } = {},
): Promise<{
  duration: number;
  width: number;
  height: number;
  size: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  audioCodecs: string[];
  pixelFormat?: string;
}> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(videoPath)) {
      return reject(new Error(`Video file not found: ${videoPath}`));
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(videoPath);
      if (stats.size === 0) {
        return reject(new Error('Video file is empty (0 bytes)'));
      }
    } catch (err: any) {
      return reject(new Error(`Failed to access video file: ${err.message}`));
    }

    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath], {
      signal,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let processError: Error | undefined;
    const timeout = setTimeout(() => {
      processError = new Error('Media probe timed out');
      proc.kill('SIGKILL');
    }, 15000);

    proc.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-1024 * 1024);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (processError) return reject(processError);
      if (signal?.aborted) return reject(new Error('Media probe cancelled'));
      const durationMatch = /Duration:\s*(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)/.exec(
        stderr,
      );
      const streamLines = stderr
        .split(/\r?\n/)
        .filter((line) => /^\s*Stream #/.test(line));
      const videoLines = streamLines.filter((line) => /Video:/.test(line));
      const videoLine =
        videoLines.find((line) => !/\(attached pic\)/.test(line)) ||
        videoLines[0] ||
        '';
      const videoMatch = /,\s*(\d{1,5})x(\d{1,5})(?:[\s,]|$)/.exec(videoLine);
      const audioCodecs = streamLines.flatMap((line) => {
        const match = /Audio:\s*(\w+)/.exec(line);
        return match ? [match[1]] : [];
      });
      const videoFormat = /Video:\s*(\w+)(?:\s*\([^)]*\))*\s*,\s*(\w+)/.exec(
        videoLine,
      );

      if (!durationMatch && !options.allowUnknownDuration) {
        return reject(
          new Error(
            `Unable to parse video duration. Invalid, corrupted, or unsupported media file. ${stderr.slice(-200)}`,
          ),
        );
      }

      const duration = durationMatch ? parseTimemark(durationMatch[1]) : 0;
      if (duration <= 0 && !options.allowUnknownDuration) {
        return reject(
          new Error(`Detected invalid video duration: ${duration}s`),
        );
      }

      const width = videoMatch ? parseInt(videoMatch[1], 10) : 0;
      const height = videoMatch ? parseInt(videoMatch[2], 10) : 0;

      resolve({
        duration,
        width,
        height,
        size: stats.size,
        hasAudio: audioCodecs.length > 0,
        videoCodec: /Video:\s*(\w+)/.exec(videoLine)?.[1],
        audioCodec: audioCodecs[0],
        audioCodecs,
        pixelFormat: videoFormat?.[2],
      });
    });

    proc.on('error', (err) => {
      processError = err;
    });
  });
}

/**
 * 构建裁剪命令行参数
 */
export function buildTrimArgs(
  config: VideoTrimConfig,
  resolvedOutputPath: string,
  subtitles: readonly EmbeddedSubtitleStream[] = [],
): string[] {
  const { videoPath, startSec, endSec, mode } = config;
  const startTime = formatFfmpegTime(startSec);
  const duration = Math.max(0.01, endSec - startSec);
  const durationStr = formatFfmpegTime(duration);

  const args: string[] = ['-hide_banner', '-y'];

  if (mode === 'lossless') {
    // 极速无损流拷贝模式：-ss 放在 -i 前实现快寻至最近关键帧，-avoid_negative_ts 保证时间戳从 0 重新对齐
    args.push(
      '-ss',
      startTime,
      '-t',
      durationStr,
      '-accurate_seek',
      '-i',
      videoPath,
      '-map',
      '0',
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      resolvedOutputPath,
    );
  } else {
    // 精确重编码模式：-ss 放在 -i 之后逐帧精确解码并裁剪，保证严格帧级时间对齐
    args.push(
      '-i',
      videoPath,
      '-ss',
      startTime,
      '-t',
      durationStr,
      '-map',
      '0:V',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      ...(path.extname(resolvedOutputPath).toLowerCase() === '.mkv'
        ? ['-map', '0:t?', '-c:t', 'copy']
        : []),
      '-c:v',
      'libx264',
      '-vf',
      EVEN_DIMENSIONS_PAD_FILTER,
      '-pix_fmt',
      COMPATIBLE_PIXEL_FORMAT,
      '-preset',
      'fast',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-c:s',
      'copy',
      ...buildSubtitleCodecOptions(path.extname(resolvedOutputPath), subtitles),
      '-avoid_negative_ts',
      'make_zero',
      resolvedOutputPath,
    );
  }

  return args;
}

/**
 * 执行视频裁剪
 */
export async function executeVideoTrim(
  config: VideoTrimConfig,
  jobId: string,
  onProgress?: (p: VideoTrimProgress) => void,
): Promise<VideoTrimResult> {
  let subtitles: EmbeddedSubtitleStream[] = [];
  if (config.mode === 'accurate') {
    const preparation = new AbortController();
    preparingTrimJobs.set(jobId, preparation);
    try {
      subtitles = await scanEmbeddedSubtitles(
        config.videoPath,
        preparation.signal,
      );
      preparation.signal.throwIfAborted();
    } finally {
      preparingTrimJobs.delete(jobId);
    }
  }
  return new Promise((resolve, reject) => {
    const { videoPath, startSec, endSec, outputPath, outputDir } = config;

    const ext = path.extname(videoPath);
    const baseName = path.basename(videoPath, ext);
    const targetDir = toolboxOutputDirectory(
      outputDir || (outputPath ? path.dirname(outputPath) : undefined),
      videoPath,
    );

    let targetOutput = outputPath;
    if (
      !targetOutput ||
      (fs.existsSync(targetOutput) && fs.statSync(targetOutput).isDirectory())
    ) {
      targetOutput = path.join(
        targetDir,
        `${baseName}_trim_${Math.round(startSec)}s-${Math.round(endSec)}s${ext}`,
      );
    }

    if (config.mode === 'accurate') {
      const parsed = path.parse(targetOutput);
      targetOutput = path.join(
        parsed.dir,
        `${parsed.name}${writableComposeExtension(parsed.ext)}`,
      );
    }

    // Validate the stream/container policy before reserving an output file.
    const args = buildTrimArgs(config, targetOutput, subtitles);
    targetOutput = reserveToolboxOutput(targetOutput);
    args[args.length - 1] = targetOutput;
    const targetDuration = Math.max(0.01, endSec - startSec);

    logMessage(
      `执行视频裁剪 [${jobId}]: ${ffmpegPath} ${args.join(' ')}`,
      'info',
    );

    const proc = spawn(ffmpegPath, args);
    activeTrimProcesses.set(jobId, proc);

    let stderr = '';

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;

      // 解析 time=00:00:10.50 进度
      const timeMatch = /time=(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)/.exec(chunk);
      if (timeMatch && onProgress) {
        const currentSeconds = parseTimemark(timeMatch[1]);
        const percent = Math.min(
          99,
          Math.max(1, Math.round((currentSeconds / targetDuration) * 100)),
        );
        onProgress({
          percent,
          currentTime: currentSeconds,
          timemark: timeMatch[1],
        });
      }
    });

    proc.on('close', (code) => {
      activeTrimProcesses.delete(jobId);

      if (code === 0 && fs.existsSync(targetOutput)) {
        const stats = fs.statSync(targetOutput);
        if (onProgress) onProgress({ percent: 100 });
        resolve({
          success: true,
          outputPath: targetOutput,
          duration: targetDuration,
          size: stats.size,
        });
      } else {
        // 如果文件已生成部分，清理残缺文件
        if (fs.existsSync(targetOutput)) {
          try {
            fs.unlinkSync(targetOutput);
          } catch {}
        }
        const errorMsg = `FFmpeg trim failed with exit code ${code}: ${stderr.slice(-300)}`;
        logMessage(errorMsg, 'error');
        resolve({
          success: false,
          outputPath: targetOutput,
          duration: 0,
          size: 0,
          error: errorMsg,
        });
      }
    });

    proc.on('error', (err) => {
      activeTrimProcesses.delete(jobId);
      try {
        fs.unlinkSync(targetOutput);
      } catch {}
      reject(err);
    });
  });
}
