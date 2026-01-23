/**
 * 字幕合并核心逻辑
 * 使用 fluent-ffmpeg 实现字幕烧录到视频
 */

import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import { logMessage } from './storeManager';
import type {
  SubtitleStyle,
  MergeConfig,
  MergeProgress,
  VideoInfo,
  SubtitleAlignment,
} from '../../types/subtitleMerge';

// 设置 ffmpeg 路径
const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * 将前端 numpad 风格的 Alignment 转换为 ASS/SSA 格式
 *
 * 前端 numpad 风格 (我们使用的):
 * 7=左上, 8=中上, 9=右上
 * 4=左中, 5=居中, 6=右中
 * 1=左下, 2=中下, 3=右下
 *
 * ASS/SSA 格式 (FFmpeg libass 使用的):
 * 底部行: 1=左下, 2=中下, 3=右下
 * 中间行: 9=左中, 10=居中, 11=右中
 * 顶部行: 5=左上, 6=中上, 7=右上
 */
function convertAlignment(numpadAlignment: SubtitleAlignment): number {
  const alignmentMap: Record<SubtitleAlignment, number> = {
    // 底部行 (保持不变)
    1: 1, // 左下 -> 1
    2: 2, // 中下 -> 2
    3: 3, // 右下 -> 3
    // 中间行
    4: 9, // 左中 -> 9
    5: 10, // 居中 -> 10
    6: 11, // 右中 -> 11
    // 顶部行
    7: 5, // 左上 -> 5
    8: 6, // 中上 -> 6
    9: 7, // 右上 -> 7
  };
  return alignmentMap[numpadAlignment] || 2;
}

/**
 * 将 CSS 颜色转换为 ASS 颜色格式
 * CSS: #RRGGBB 或 rgba(r, g, b, a)
 * ASS: &HAABBGGRR (Alpha, Blue, Green, Red)
 */
export function cssColorToAss(cssColor: string, alpha: number = 0): string {
  let r: number, g: number, b: number;

  if (cssColor.startsWith('#')) {
    // 处理 #RRGGBB 格式
    const hex = cssColor.slice(1);
    r = parseInt(hex.substr(0, 2), 16);
    g = parseInt(hex.substr(2, 2), 16);
    b = parseInt(hex.substr(4, 2), 16);
  } else if (cssColor.startsWith('rgb')) {
    // 处理 rgba(r, g, b, a) 格式
    const match = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      r = parseInt(match[1]);
      g = parseInt(match[2]);
      b = parseInt(match[3]);
    } else {
      // 默认白色
      r = 255;
      g = 255;
      b = 255;
    }
  } else {
    // 默认白色
    r = 255;
    g = 255;
    b = 255;
  }

  // 转换为 ASS 格式: &HAABBGGRR
  const alphaHex = alpha.toString(16).padStart(2, '0').toUpperCase();
  const blueHex = b.toString(16).padStart(2, '0').toUpperCase();
  const greenHex = g.toString(16).padStart(2, '0').toUpperCase();
  const redHex = r.toString(16).padStart(2, '0').toUpperCase();

  return `&H${alphaHex}${blueHex}${greenHex}${redHex}`;
}

/**
 * 构建 force_style 参数字符串
 */
export function buildForceStyle(style: SubtitleStyle): string {
  const parts: string[] = [];

  // 字体设置
  parts.push(`FontName=${style.fontName}`);
  parts.push(`FontSize=${style.fontSize}`);

  // 颜色设置 (ASS 格式)
  parts.push(`PrimaryColour=${cssColorToAss(style.primaryColor)}`);
  parts.push(`OutlineColour=${cssColorToAss(style.outlineColor)}`);
  parts.push(`BackColour=${cssColorToAss(style.backColor, 128)}`);

  // 字体样式
  if (style.bold) parts.push('Bold=1');
  if (style.italic) parts.push('Italic=1');
  if (style.underline) parts.push('Underline=1');

  // 边框和阴影
  parts.push(`BorderStyle=${style.borderStyle}`);
  parts.push(`Outline=${style.outline}`);
  parts.push(`Shadow=${style.shadow}`);

  // 对齐位置 (转换为 ASS 格式)
  const assAlignment = convertAlignment(style.alignment);
  parts.push(`Alignment=${assAlignment}`);

  // 边距
  parts.push(`MarginL=${style.marginL}`);
  parts.push(`MarginR=${style.marginR}`);
  parts.push(`MarginV=${style.marginV}`);

  return parts.join(',');
}

/**
 * 转义字幕文件路径以用于 FFmpeg 滤镜
 * Windows 路径需要特殊处理
 */
export function escapeSubtitlePath(subtitlePath: string): string {
  // 将反斜杠转换为正斜杠
  let escaped = subtitlePath.replace(/\\/g, '/');
  // 转义特殊字符: : \ ' [
  escaped = escaped
    .replace(/:/g, '\\:')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[');
  return escaped;
}

/**
 * 获取视频信息
 */
export function getVideoInfo(videoPath: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        logMessage(`获取视频信息失败: ${err.message}`, 'error');
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find(
        (s) => s.codec_type === 'video',
      );
      const stats = fs.statSync(videoPath);

      resolve({
        path: videoPath,
        fileName: path.basename(videoPath),
        duration: metadata.format.duration || 0,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        size: stats.size,
      });
    });
  });
}

/**
 * 合并字幕到视频
 */
export function mergeSubtitleToVideo(
  config: MergeConfig,
  onProgress?: (progress: MergeProgress) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { videoPath, subtitlePath, outputPath, style } = config;

    const forceStyle = buildForceStyle(style);
    const escapedSubPath = escapeSubtitlePath(subtitlePath);
    const subtitlesFilter = `subtitles='${escapedSubPath}':force_style='${forceStyle}'`;

    logMessage(`开始合并字幕: ${videoPath}`, 'info');
    logMessage(`字幕文件: ${subtitlePath}`, 'info');
    logMessage(`输出文件: ${outputPath}`, 'info');
    logMessage(`force_style: ${forceStyle}`, 'info');

    // 发送初始进度
    onProgress?.({
      percent: 0,
      timeMark: '00:00:00',
      targetSize: 0,
      status: 'processing',
    });

    ffmpeg(videoPath)
      .videoFilters(subtitlesFilter)
      .outputOptions([
        '-c:a',
        'copy', // 保持音频编码不变
        '-y', // 覆盖输出文件
      ])
      .on('start', (cmd) => {
        logMessage(`FFmpeg 命令: ${cmd}`, 'info');
      })
      .on('progress', (progress) => {
        const percent = progress.percent || 0;
        logMessage(`合并进度: ${percent.toFixed(1)}%`, 'info');
        onProgress?.({
          percent: Math.min(percent, 99),
          timeMark: progress.timemark || '00:00:00',
          targetSize: progress.targetSize || 0,
          status: 'processing',
        });
      })
      .on('end', () => {
        logMessage('字幕合并完成', 'info');
        onProgress?.({
          percent: 100,
          timeMark: '',
          targetSize: 0,
          status: 'completed',
        });
        resolve(outputPath);
      })
      .on('error', (err) => {
        logMessage(`字幕合并失败: ${err.message}`, 'error');
        onProgress?.({
          percent: 0,
          timeMark: '',
          targetSize: 0,
          status: 'error',
          errorMessage: err.message,
        });
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * 生成默认输出路径
 */
export function generateOutputPath(
  videoPath: string,
  suffix: string = '_subtitled',
): string {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const baseName = path.basename(videoPath, ext);
  return path.join(dir, `${baseName}${suffix}${ext}`);
}

/**
 * 检查字幕文件格式
 */
export function getSubtitleFormat(subtitlePath: string): string {
  const ext = path.extname(subtitlePath).toLowerCase();
  const formatMap: Record<string, string> = {
    '.srt': 'srt',
    '.ass': 'ass',
    '.ssa': 'ssa',
    '.vtt': 'vtt',
  };
  return formatMap[ext] || 'unknown';
}

/**
 * 统计字幕条数
 */
export async function countSubtitles(subtitlePath: string): Promise<number> {
  try {
    const content = await fs.promises.readFile(subtitlePath, 'utf-8');
    const format = getSubtitleFormat(subtitlePath);

    if (format === 'srt') {
      // SRT 格式: 通过数字序号计数
      const matches = content.match(/^\d+\s*$/gm);
      return matches ? matches.length : 0;
    } else if (format === 'ass' || format === 'ssa') {
      // ASS/SSA 格式: 通过 Dialogue 行计数
      const matches = content.match(/^Dialogue:/gm);
      return matches ? matches.length : 0;
    } else if (format === 'vtt') {
      // VTT 格式: 通过时间戳行计数
      const matches = content.match(/^\d{2}:\d{2}/gm);
      return matches ? matches.length : 0;
    }

    return 0;
  } catch (error) {
    logMessage(`统计字幕条数失败: ${error}`, 'error');
    return 0;
  }
}
