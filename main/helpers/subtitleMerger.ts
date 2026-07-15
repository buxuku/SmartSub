/**
 * 字幕合成 · 滤镜/样式助手与文件信息工具。
 *
 * 合成执行体已收敛到统一合成引擎（compose/composeRunner + composeQueue，
 * 支持「字幕 × 音轨」矩阵单遍编码）；本模块保留烧录滤镜构建（force_style /
 * ASS 生成，预览 IPC 共用）、路径安全副本与视频/字幕信息工具。
 */

import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { logMessage } from './storeManager';
import type { SubtitleStyle, VideoInfo } from '../../types/subtitleMerge';
import {
  detectSubtitleFormatFromContent,
  parseSubtitleCues,
} from './subtitleFormats';
import {
  buildAssDocument,
  cssColorToAss,
  convertAlignment,
  backOpacityToAssAlpha,
} from './assStyleBuilder';
import { containsCJK, resolveBurnFontName } from './fontResolver';

// 设置 ffmpeg 路径
const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegPath);

/** 取消哨兵：渲染层据此把取消与真实错误区分开 */
export const MERGE_CANCELLED = 'MERGE_CANCELLED';

/**
 * 构建 force_style 参数字符串（仅用于 ASS/SSA 输入文件的样式覆盖路径；
 * SRT/VTT/LRC 输入走预生成 ASS 管线，见 assStyleBuilder.buildAssDocument）。
 * 颜色映射与 buildAssStyleLine 保持相同语义（BorderStyle=3 背景框取色自 OutlineColour）。
 */
export function buildForceStyle(style: SubtitleStyle): string {
  const parts: string[] = [];
  const assAlpha = backOpacityToAssAlpha(style.backOpacity);
  const isBoxMode = style.borderStyle === 3;

  // 字体设置
  parts.push(`FontName=${style.fontName}`);
  parts.push(`FontSize=${style.fontSize}`);

  // 颜色设置（ASS 格式，背景框模式下 libass 用 OutlineColour 绘制背景框）
  parts.push(`PrimaryColour=${cssColorToAss(style.primaryColor)}`);
  parts.push(
    `OutlineColour=${
      isBoxMode
        ? cssColorToAss(style.backColor, assAlpha)
        : cssColorToAss(style.outlineColor)
    }`,
  );
  parts.push(`BackColour=${cssColorToAss(style.backColor, assAlpha)}`);

  // 字体样式
  if (style.bold) parts.push('Bold=1');
  if (style.italic) parts.push('Italic=1');
  if (style.underline) parts.push('Underline=1');

  // 边框和阴影（与 buildAssStyleLine 同语义：背景框模式 Outline 钳到最小 1、Shadow 钳 0）
  parts.push(`BorderStyle=${style.borderStyle}`);
  parts.push(
    `Outline=${isBoxMode ? Math.max(style.outline, 1) : style.outline}`,
  );
  parts.push(`Shadow=${isBoxMode ? 0 : style.shadow}`);

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
  // 转义特殊字符: : ' [
  // 注意: 先转义 : 和 [，再转义 '（避免引入的 \ 被重复转义）
  // 此时路径中不应有反斜杠（已全部转为正斜杠），所以不需要转义 \
  escaped = escaped
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/'/g, "\\'");
  return escaped;
}

/**
 * 将字幕文件复制到临时目录，使用安全的文件名（无特殊字符）
 * 返回临时文件路径。调用方需要在使用完毕后清理临时文件。
 *
 * 这是处理包含特殊字符（如单引号 ' ）路径的最可靠方式，
 * 因为 ffmpeg 的滤镜字符串解析在不同版本和不同库封装下行为可能不一致。
 */
export function createSafeSubtitleCopy(subtitlePath: string): string {
  const ext = path.extname(subtitlePath);
  const tmpDir = path.join(os.tmpdir(), 'video-subtitle-master');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const safeName = `subtitle_${Date.now()}${ext}`;
  const tmpPath = path.join(tmpDir, safeName);
  fs.copyFileSync(subtitlePath, tmpPath);
  logMessage(`创建临时字幕文件: ${tmpPath}`, 'info');
  return tmpPath;
}

/**
 * 清理临时字幕文件
 */
export function cleanupTempSubtitle(tmpPath: string): void {
  try {
    if (tmpPath.includes('video-subtitle-master') && fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
      logMessage(`清理临时字幕文件: ${tmpPath}`, 'info');
    }
  } catch (err) {
    logMessage(`清理临时文件失败: ${err}`, 'warning');
  }
}

// 备注：CJK 字体兜底逻辑已抽至 fontResolver.ts（烧录与 JASSUB 预览共用）。
// 曾尝试给 libass 传 fontsdir 兜底，但实测打包版 ffmpeg 的默认 fontconfig
// 已能按 family 名解析系统 CJK 字体（含 Supplemental 目录），fontsdir 反而会触发
// 扫描整目录的无害告警（如 Apple Color Emoji 元数据读取失败），故移除。

/**
 * 按当前样式为字幕文件生成 ASS 文档（烧录与预览共用，保证所见即所得）。
 * 内含 CJK 字体兜底：字幕含中文而所选字体无 CJK 字形/本机不可用时替换 Fontname。
 */
export function buildAssForSubtitle(
  subtitleContent: string,
  subtitlePath: string,
  style: SubtitleStyle,
): { assContent: string; effectiveStyle: SubtitleStyle } {
  const format = detectSubtitleFormatFromContent(subtitlePath, subtitleContent);
  const cues = parseSubtitleCues(subtitleContent, format);

  let effectiveStyle = style;
  const hasCJK = containsCJK(subtitleContent);
  const burnFont = resolveBurnFontName(style.fontName, hasCJK);
  if (burnFont !== style.fontName) {
    effectiveStyle = { ...style, fontName: burnFont };
    logMessage(
      `字幕含中文，但所选字体「${style.fontName}」在本机不可用/无 CJK 字形，已改用「${burnFont}」`,
      'warning',
    );
  }

  return { assContent: buildAssDocument(cues, effectiveStyle), effectiveStyle };
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
