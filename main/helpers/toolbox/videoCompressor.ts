/**
 * 社交分享轻量视频压缩服务
 *
 * 提供微信分享（<25MB）、社交均衡 1080p、极速 720p 及指定目标体积压缩模式。
 */

import fs from 'fs';
import { reserveToolboxOutput } from './outputPath';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logMessage } from '../logger';
import { probeVideoInfo } from './videoTrimmer';
import type {
  VideoCompressConfig,
  VideoCompressResult,
} from '../../../types/toolbox';

const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

const activeCompressProcesses = new Map<string, ChildProcess>();
const preparingCompressJobs = new Map<string, AbortController>();

export function cancelVideoCompress(jobId: string): boolean {
  const preparing = preparingCompressJobs.get(jobId);
  if (preparing) {
    preparing.abort();
    return true;
  }
  const proc = activeCompressProcesses.get(jobId);
  if (proc) {
    try {
      proc.kill('SIGKILL');
      activeCompressProcesses.delete(jobId);
      logMessage(`已终止视频压缩进程: ${jobId}`, 'info');
      return true;
    } catch (err) {
      logMessage(`终止视频压缩进程异常: ${err}`, 'warning');
    }
  }
  return false;
}

/** 取消并清理所有正在进行的视频压缩任务（应用退出时调用） */
export function cancelAllCompressProcesses(): void {
  preparingCompressJobs.forEach((controller) => controller.abort());
  for (const [jobId, proc] of activeCompressProcesses.entries()) {
    try {
      proc.kill('SIGKILL');
      logMessage(`关闭应用: 已清理视频压缩子进程 ${jobId}`, 'info');
    } catch {}
  }
  activeCompressProcesses.clear();
}

export async function executeVideoCompress(
  config: VideoCompressConfig,
  jobId: string,
  onProgress?: (percent: number) => void,
): Promise<VideoCompressResult> {
  const { videoPath, preset, targetSizeMb = 24, outputPath } = config;

  if (!fs.existsSync(videoPath)) {
    return {
      success: false,
      outputPath: '',
      originalSize: 0,
      compressedSize: 0,
      error: `Video not found: ${videoPath}`,
    };
  }

  const preparation = new AbortController();
  preparingCompressJobs.set(jobId, preparation);
  let origInfo: Awaited<ReturnType<typeof probeVideoInfo>>;
  try {
    origInfo = await probeVideoInfo(videoPath);
  } finally {
    preparingCompressJobs.delete(jobId);
  }
  if (preparation.signal.aborted)
    return {
      success: false,
      outputPath: '',
      originalSize: 0,
      compressedSize: 0,
      error: 'Cancelled',
    };
  const dir = outputPath ? path.dirname(outputPath) : path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const baseName = path.basename(videoPath, ext);

  const targetOutput = reserveToolboxOutput(
    outputPath || path.join(dir, `${baseName}_compressed.mp4`),
  );

  const args: string[] = ['-hide_banner', '-y', '-i', videoPath];

  if (preset === 'wechat_25mb' || preset === 'target_size') {
    const targetMb = preset === 'wechat_25mb' ? 24 : targetSizeMb;
    const duration = Math.max(1, origInfo.duration);
    // 总比特数 / 时长 - 音频 96kbps
    const totalBits = targetMb * 8 * 1024 * 1024;
    const audioBitrate = 96 * 1000;
    const videoBitrate = Math.max(
      150000,
      Math.floor(totalBits / duration - audioBitrate),
    );

    args.push(
      '-c:v',
      'libx264',
      '-b:v',
      `${videoBitrate}`,
      '-maxrate',
      `${Math.floor(videoBitrate * 1.3)}`,
      '-bufsize',
      `${videoBitrate * 2}`,
      '-vf',
      "scale='min(1280,iw)':-2",
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
    );
  } else if (preset === 'fast_720p') {
    args.push(
      '-c:v',
      'libx264',
      '-crf',
      '26',
      '-preset',
      'veryfast',
      '-vf',
      "scale='min(1280,iw)':-2",
      '-c:a',
      'aac',
      '-b:a',
      '96k',
    );
  } else {
    // balanced_1080p
    args.push(
      '-c:v',
      'libx264',
      '-crf',
      '24',
      '-preset',
      'fast',
      '-vf',
      "scale='min(1920,iw)':-2",
      '-c:a',
      'aac',
      '-b:a',
      '128k',
    );
  }

  args.push(targetOutput);

  logMessage(
    `执行视频压缩 [${jobId}]: ${ffmpegPath} ${args.join(' ')}`,
    'info',
  );

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    activeCompressProcesses.set(jobId, proc);

    let stderr = '';
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      const timeMatch = /time=(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)/.exec(chunk);
      if (timeMatch && onProgress && origInfo.duration > 0) {
        const parts = timeMatch[1].split(':');
        const s =
          parseInt(parts[0], 10) * 3600 +
          parseInt(parts[1], 10) * 60 +
          parseFloat(parts[2]);
        const percent = Math.min(
          99,
          Math.max(1, Math.round((s / origInfo.duration) * 100)),
        );
        onProgress(percent);
      }
    });

    proc.on('close', (code) => {
      activeCompressProcesses.delete(jobId);
      if (code === 0 && fs.existsSync(targetOutput)) {
        const stats = fs.statSync(targetOutput);
        if (onProgress) onProgress(100);
        resolve({
          success: true,
          outputPath: targetOutput,
          originalSize: origInfo.size,
          compressedSize: stats.size,
        });
      } else {
        if (fs.existsSync(targetOutput)) {
          try {
            fs.unlinkSync(targetOutput);
          } catch {}
        }
        resolve({
          success: false,
          outputPath: targetOutput,
          originalSize: origInfo.size,
          compressedSize: 0,
          error: `Compress failed: ${stderr.slice(-300)}`,
        });
      }
    });

    proc.on('error', (err) => {
      activeCompressProcesses.delete(jobId);
      try {
        fs.unlinkSync(targetOutput);
      } catch {}
      reject(err);
    });
  });
}
