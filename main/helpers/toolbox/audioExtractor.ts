/**
 * 音频提取与格式转换服务
 *
 * 支持从视频中提取音轨为 MP3, WAV, AAC, M4A, FLAC；
 * 支持 16kHz 16-bit 单声道 WAV 预设（无缝对接各类 ASR 引擎）；
 * 支持取消与进度回调。
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logMessage } from '../logger';
import type {
  AudioExtractConfig,
  AudioExtractResult,
} from '../../../types/toolbox';

const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

/** 正在执行的提取进程：jobId -> ChildProcess */
const activeExtractProcesses = new Map<string, ChildProcess>();

export function cancelAudioExtract(jobId: string): boolean {
  const proc = activeExtractProcesses.get(jobId);
  if (proc) {
    try {
      proc.kill('SIGKILL');
      activeExtractProcesses.delete(jobId);
      logMessage(`已终止音频提取进程: ${jobId}`, 'info');
      return true;
    } catch (err) {
      logMessage(`终止音频提取进程异常: ${err}`, 'warning');
    }
  }
  return false;
}

/** 取消并清理所有正在进行的音频提取任务（应用关闭时调用） */
export function cancelAllAudioProcesses(): void {
  for (const [jobId, proc] of activeExtractProcesses.entries()) {
    try {
      proc.kill('SIGKILL');
      logMessage(`关闭应用: 已清理音频提取子进程 ${jobId}`, 'info');
    } catch {}
  }
  activeExtractProcesses.clear();
}

/** 时间标记 "00:01:23.45" 转换为秒数 */
function parseTimemark(timemark: string): number {
  const match = /(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(timemark);
  if (!match) return 0;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const ms = match[4] ? parseFloat(`0.${match[4]}`) : 0;
  return h * 3600 + m * 60 + s + ms;
}

export function buildAudioExtractArgs(
  config: AudioExtractConfig,
  resolvedOutputPath: string,
): string[] {
  const { videoPath, format, bitrate = '320k', wavPreset } = config;
  const args: string[] = ['-hide_banner', '-y', '-i', videoPath, '-vn'];

  switch (format) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
      break;
    case 'wav':
      if (wavPreset === 'asr_16k_mono') {
        args.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le');
      } else {
        args.push('-c:a', 'pcm_s16le');
      }
      break;
    case 'aac':
      args.push('-c:a', 'aac', '-b:a', bitrate);
      break;
    case 'm4a':
      args.push('-c:a', 'aac', '-b:a', bitrate);
      break;
    case 'flac':
      args.push('-c:a', 'flac');
      break;
    default:
      args.push('-c:a', 'copy');
      break;
  }

  args.push(resolvedOutputPath);
  return args;
}

export function executeAudioExtract(
  config: AudioExtractConfig,
  jobId: string,
  onProgress?: (percent: number) => void,
): Promise<AudioExtractResult> {
  return new Promise((resolve, reject) => {
    const { videoPath, format, outputPath } = config;

    if (!fs.existsSync(videoPath)) {
      return resolve({
        success: false,
        outputPath: '',
        format,
        size: 0,
        error: `Source video not found: ${videoPath}`,
      });
    }

    const dir = outputPath ? path.dirname(outputPath) : path.dirname(videoPath);
    const ext = path.extname(videoPath);
    const baseName = path.basename(videoPath, ext);

    const targetOutput =
      outputPath || path.join(dir, `${baseName}.${format}`);
    const args = buildAudioExtractArgs(config, targetOutput);

    logMessage(`执行音频提取 [${jobId}]: ${ffmpegPath} ${args.join(' ')}`, 'info');

    const proc = spawn(ffmpegPath, args);
    activeExtractProcesses.set(jobId, proc);

    let stderr = '';
    let totalDuration = 0;

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;

      if (!totalDuration) {
        const durMatch = /Duration:\s*(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)/.exec(stderr);
        if (durMatch) {
          totalDuration = parseTimemark(durMatch[1]);
        }
      }

      if (totalDuration > 0 && onProgress) {
        const timeMatch = /time=(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)/.exec(chunk);
        if (timeMatch) {
          const currentSec = parseTimemark(timeMatch[1]);
          const percent = Math.min(
            99,
            Math.max(1, Math.round((currentSec / totalDuration) * 100)),
          );
          onProgress(percent);
        }
      }
    });

    proc.on('close', (code) => {
      activeExtractProcesses.delete(jobId);

      if (code === 0 && fs.existsSync(targetOutput)) {
        const stats = fs.statSync(targetOutput);
        if (onProgress) onProgress(100);
        resolve({
          success: true,
          outputPath: targetOutput,
          format,
          size: stats.size,
        });
      } else {
        if (fs.existsSync(targetOutput)) {
          try {
            fs.unlinkSync(targetOutput);
          } catch {}
        }
        const errorMsg = `Audio extract failed with exit code ${code}: ${stderr.slice(-300)}`;
        logMessage(errorMsg, 'error');
        resolve({
          success: false,
          outputPath: targetOutput,
          format,
          size: 0,
          error: errorMsg,
        });
      }
    });

    proc.on('error', (err) => {
      activeExtractProcesses.delete(jobId);
      reject(err);
    });
  });
}
