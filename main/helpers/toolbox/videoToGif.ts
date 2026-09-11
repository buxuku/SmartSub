/**
 * 视频转高清 GIF 动图服务
 *
 * 采用双通道调色板算法（PaletteGen + PaletteUse），避免常规转 GIF 的色阶断层与严重噪点；
 * 配合 Lanczos 高质量下采样算法与自适应帧率，生成高画质、体积均衡的 GIF 表情包/动图。
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logMessage } from '../logger';
import { formatFfmpegTime } from './videoTrimmer';
import type { VideoToGifConfig, VideoToGifResult } from '../../../types/toolbox';

const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

const activeGifProcesses = new Map<string, ChildProcess>();

export function cancelVideoToGif(jobId: string): boolean {
  const proc = activeGifProcesses.get(jobId);
  if (proc) {
    try {
      proc.kill('SIGKILL');
      activeGifProcesses.delete(jobId);
      logMessage(`已终止 GIF 生成进程: ${jobId}`, 'info');
      return true;
    } catch (err) {
      logMessage(`终止 GIF 生成进程异常: ${err}`, 'warning');
    }
  }
  return false;
}

/** 取消并清理所有正在进行的 GIF 制作任务（应用退出时调用） */
export function cancelAllGifProcesses(): void {
  for (const [jobId, proc] of activeGifProcesses.entries()) {
    try {
      proc.kill('SIGKILL');
      logMessage(`关闭应用: 已清理 GIF 生成子进程 ${jobId}`, 'info');
    } catch {}
  }
  activeGifProcesses.clear();
}

export function executeVideoToGif(
  config: VideoToGifConfig,
  jobId: string,
  onProgress?: (percent: number) => void,
): Promise<VideoToGifResult> {
  return new Promise((resolve, reject) => {
    const { videoPath, startSec, endSec, fps = 12, width = 480, outputPath } = config;

    if (!fs.existsSync(videoPath)) {
      return resolve({
        success: false,
        outputPath: '',
        size: 0,
        error: `Source video not found: ${videoPath}`,
      });
    }

    const dir = outputPath ? path.dirname(outputPath) : path.dirname(videoPath);
    const baseName = path.basename(videoPath, path.extname(videoPath));

    const targetOutput =
      outputPath || path.join(dir, `${baseName}_clip.gif`);

    const duration = Math.max(0.1, endSec - startSec);
    const startStr = formatFfmpegTime(startSec);
    const durStr = formatFfmpegTime(duration);

    // 采用专业两阶段调色板滤镜：fps -> scale -> split -> palettegen -> paletteuse
    const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;

    const args = [
      '-hide_banner',
      '-y',
      '-ss', startStr,
      '-t', durStr,
      '-i', videoPath,
      '-vf', filter,
      '-loop', '0',
      targetOutput,
    ];

    logMessage(`执行 GIF 生成 [${jobId}]: ${ffmpegPath} ${args.join(' ')}`, 'info');

    const proc = spawn(ffmpegPath, args);
    activeGifProcesses.set(jobId, proc);

    let stderr = '';
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      const timeMatch = /time=(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)/.exec(chunk);
      if (timeMatch && onProgress) {
        const parts = timeMatch[1].split(':');
        const s =
          parseInt(parts[0], 10) * 3600 +
          parseInt(parts[1], 10) * 60 +
          parseFloat(parts[2]);
        const percent = Math.min(
          99,
          Math.max(1, Math.round((s / duration) * 100)),
        );
        onProgress(percent);
      }
    });

    proc.on('close', (code) => {
      activeGifProcesses.delete(jobId);
      if (code === 0 && fs.existsSync(targetOutput)) {
        const stats = fs.statSync(targetOutput);
        if (onProgress) onProgress(100);
        resolve({
          success: true,
          outputPath: targetOutput,
          size: stats.size,
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
          size: 0,
          error: `GIF generation failed: ${stderr.slice(-300)}`,
        });
      }
    });

    proc.on('error', (err) => {
      activeGifProcesses.delete(jobId);
      reject(err);
    });
  });
}
