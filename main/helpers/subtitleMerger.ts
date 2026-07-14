/**
 * 字幕合并核心逻辑
 * 使用 fluent-ffmpeg 实现字幕烧录到视频
 */

import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { logMessage } from './storeManager';
import { timemarkToSeconds } from './fileUtils';
import type {
  SubtitleStyle,
  MergeConfig,
  MergeProgress,
  VideoInfo,
  EncoderMode,
  HwEncoderId,
  VideoQuality,
} from '../../types/subtitleMerge';
import {
  VIDEO_QUALITY_CRF,
  HW_QUALITY_MAPPING,
  VT_BITRATE_QUALITY_FACTOR,
} from '../../types/subtitleMerge';
import {
  getHwAccelInfo,
  buildHwCqArgs,
  buildVtBitrateArgs,
} from './hwEncoderDetector';
import {
  detectSubtitleFormatFromContent,
  parseSubtitleCues,
} from './subtitleFormats';
import {
  buildAssDocument,
  buildAssStyleLine,
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

// 合成同时只有一个（UI 在处理中禁用入口），单例引用即可
let currentMergeCommand: ReturnType<typeof ffmpeg> | null = null;
let mergeCancelled = false;

/** 取消当前合成：kill ffmpeg；error 回调里完成半成品清理 */
export function cancelCurrentMerge(): boolean {
  if (!currentMergeCommand) return false;
  mergeCancelled = true;
  try {
    currentMergeCommand.kill('SIGKILL');
    logMessage('字幕合成已被用户取消', 'warning');
    return true;
  } catch (error) {
    logMessage(`取消合成失败: ${error}`, 'warning');
    return false;
  }
}

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

/**
 * 判断路径是否包含需要特殊处理的字符
 */
function pathNeedsSafeCopy(filePath: string): boolean {
  // 包含单引号、反斜杠（非路径分隔符）、冒号（非Windows盘符）等特殊字符
  return /['\[\];,]/.test(filePath);
}

// 备注：CJK 字体兜底逻辑已抽至 fontResolver.ts（烧录与 JASSUB 预览共用）。
// 曾尝试给 libass 传 fontsdir 兜底，但实测打包版 ffmpeg 的默认 fontconfig
// 已能按 family 名解析系统 CJK 字体（含 Supplemental 目录），fontsdir 反而会触发
// 扫描整目录的无害告警（如 Apple Color Emoji 元数据读取失败），故移除。

/** ASS/SSA 输入走 force_style 覆盖路径；其它格式走预生成 ASS 管线 */
function isAssInput(subtitlePath: string, content: string): boolean {
  return detectSubtitleFormatFromContent(subtitlePath, content) === 'ass';
}

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

/** 将生成的 ASS 文本写入临时目录，返回临时文件路径（调用方负责清理） */
function writeTempAssFile(assContent: string): string {
  const tmpDir = path.join(os.tmpdir(), 'video-subtitle-master');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tmpPath = path.join(tmpDir, `burn_${Date.now()}.ass`);
  fs.writeFileSync(tmpPath, assContent, 'utf-8');
  logMessage(`生成临时 ASS 字幕文件: ${tmpPath}`, 'info');
  return tmpPath;
}

/** 4K（高度≥1800）在画质档位基准上 CRF +2：高像素密度下感知质量冗余，控制体积 */
const CRF_4K_HEIGHT_THRESHOLD = 1800;
const CRF_4K_ADJUSTMENT = 2;

/** VT 码率模式：总码率中视频占比估算系数（扣除音频等非视频流） */
const VT_AUDIO_DEDUCTION = 0.85;

/** 解析后的视频编码方案（hardcode 分支用） */
interface ResolvedVideoEncoding {
  /** 实际选用的编码器 */
  encoder: 'libx264' | HwEncoderId;
  /** 从 -c:v 起的完整视频编码参数 */
  args: string[];
  /** 硬件编码器仅接受 8-bit 4:2:0：滤镜链需追加 format=nv12 */
  needsNv12: boolean;
}

/** 失败/取消后删除写了一半的输出文件，不留半成品 */
function cleanupPartialOutput(outputPath: string): void {
  try {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
      logMessage(`已删除未完成的输出文件: ${outputPath}`, 'info');
    }
  } catch (cleanupErr) {
    logMessage(`删除未完成输出文件失败: ${cleanupErr}`, 'warning');
  }
}

/** CPU 编码方案：libx264 + 画质档位 CRF（含 4K 偏移），维持既有行为 */
function buildCpuEncoding(
  videoQuality: VideoQuality,
  videoHeight: number,
): ResolvedVideoEncoding {
  const baseCrf = VIDEO_QUALITY_CRF[videoQuality] ?? VIDEO_QUALITY_CRF.original;
  // 4K 像素密度下同等 CRF 感知质量冗余，+2 控制体积（分辨率获取失败时不偏移）
  const crfAdjustment =
    videoHeight >= CRF_4K_HEIGHT_THRESHOLD ? CRF_4K_ADJUSTMENT : 0;
  const crf = baseCrf + crfAdjustment;
  logMessage(
    `hardcode video quality: ${videoQuality} (encoder=libx264, base crf=${baseCrf}, ` +
      `resolution adjustment=${crfAdjustment > 0 ? `+${crfAdjustment} (height=${videoHeight})` : '0'}, final crf=${crf})`,
    'info',
  );
  return {
    encoder: 'libx264',
    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf)],
    needsNv12: false,
  };
}

/** VT 码率模式目标码率按分辨率钳位（实现期定值，防低码率糊片与高码率浪费） */
function clampVtBitrate(bitrate: number, videoHeight: number): number {
  let min = 800_000;
  let max = 16_000_000;
  if (videoHeight >= CRF_4K_HEIGHT_THRESHOLD) {
    min = 4_000_000;
    max = 50_000_000;
  } else if (videoHeight >= 900) {
    min = 1_500_000;
    max = 16_000_000;
  } else if (videoHeight > 0) {
    min = 500_000;
    max = 8_000_000;
  }
  return Math.min(Math.max(Math.round(bitrate), min), max);
}

/** 恒定质量参数按编码器量纲钳位（VT 1-100，nvenc/qsv 1-51） */
function clampHwCq(encoderId: HwEncoderId, value: number): number {
  const max = encoderId === 'h264_videotoolbox' ? 100 : 51;
  return Math.min(Math.max(Math.round(value), 1), max);
}

/**
 * 按编码方式解析视频编码方案：
 * - cpu/未传 → libx264 现状参数；
 * - hardware → 探测缓存编码器 + 画质映射参数；探测不可用、码率估算失败均回落 libx264。
 */
async function resolveVideoEncoding(params: {
  encoderMode: EncoderMode;
  videoQuality: VideoQuality;
  videoHeight: number;
  videoPath: string;
  durationSec: number;
}): Promise<ResolvedVideoEncoding> {
  const { encoderMode, videoQuality, videoHeight, videoPath, durationSec } =
    params;
  if (encoderMode !== 'hardware') {
    return buildCpuEncoding(videoQuality, videoHeight);
  }

  const hwInfo = await getHwAccelInfo();
  if (!hwInfo.available || !hwInfo.encoderId || !hwInfo.rateMode) {
    logMessage('硬件加速不可用（探测无可用编码器），改用 CPU 编码', 'warning');
    return buildCpuEncoding(videoQuality, videoHeight);
  }
  const encoderId = hwInfo.encoderId;

  if (hwInfo.rateMode === 'bitrate') {
    // VT 码率模式（Intel Mac，无恒定质量支持）：按源码率估算目标码率
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(videoPath).size;
    } catch {
      // 统计失败按 0 处理，走下方回落
    }
    if (sizeBytes <= 0 || durationSec <= 0) {
      logMessage(
        '硬件加速码率估算失败（无法获取文件大小/时长），改用 CPU 编码',
        'warning',
      );
      return buildCpuEncoding(videoQuality, videoHeight);
    }
    const totalBitrate = (sizeBytes * 8) / durationSec;
    const factor = VT_BITRATE_QUALITY_FACTOR[videoQuality] ?? 1.0;
    const target = clampVtBitrate(
      totalBitrate * VT_AUDIO_DEDUCTION * factor,
      videoHeight,
    );
    const maxrate = Math.round(target * 1.5);
    const bufsize = target * 2;
    logMessage(
      `hardcode video quality: ${videoQuality} (encoder=${encoderId}, mode=bitrate, ` +
        `source total=${Math.round(totalBitrate / 1000)}kbps, target=${Math.round(target / 1000)}kbps)`,
      'info',
    );
    return {
      encoder: encoderId,
      args: buildVtBitrateArgs(target, maxrate, bufsize),
      needsNv12: true,
    };
  }

  const mapping = HW_QUALITY_MAPPING[encoderId];
  const base = mapping.cq[videoQuality] ?? mapping.cq.original;
  const adjustment =
    videoHeight >= CRF_4K_HEIGHT_THRESHOLD ? mapping.fourKAdjustment : 0;
  const cq = clampHwCq(encoderId, base + adjustment);
  logMessage(
    `hardcode video quality: ${videoQuality} (encoder=${encoderId}, mode=cq, base=${base}, ` +
      `resolution adjustment=${adjustment !== 0 ? `${adjustment > 0 ? '+' : ''}${adjustment} (height=${videoHeight})` : '0'}, final=${cq})`,
    'info',
  );
  return {
    encoder: encoderId,
    args: buildHwCqArgs(encoderId, cq),
    needsNv12: true,
  };
}

/**
 * 用打包的 ffmpeg-static 探测视频分辨率与时长（ffprobe 兜底）。
 * getVideoInfo 依赖系统 ffprobe（应用不打包），大量用户环境没有；
 * `ffmpeg -i` 的 stderr 流信息始终可用。时长供 VT 码率模式估算源码率。
 */
function probeResolutionViaFfmpeg(
  videoPath: string,
): Promise<{ width: number; height: number; durationSec: number } | null> {
  return new Promise((resolve) => {
    const { execFile } =
      require('child_process') as typeof import('child_process');
    // ffmpeg -i 无输出文件会以非零码退出，但 stderr 已包含流信息
    execFile(
      ffmpegPath,
      ['-hide_banner', '-i', videoPath],
      { timeout: 10000 },
      (_err, _stdout, stderr) => {
        const match = /Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(stderr || '');
        if (match) {
          const durationMatch =
            /Duration:\s*(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)/.exec(stderr || '');
          resolve({
            width: Number(match[1]),
            height: Number(match[2]),
            durationSec: durationMatch
              ? timemarkToSeconds(durationMatch[1])
              : 0,
          });
        } else {
          resolve(null);
        }
      },
    );
  });
}

/** MP4 系容器（支持 -movflags +faststart） */
const FASTSTART_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

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
export async function mergeSubtitleToVideo(
  config: MergeConfig,
  onProgress?: (progress: MergeProgress) => void,
): Promise<string> {
  const {
    videoPath,
    subtitlePath,
    outputPath,
    style,
    outputMode = 'hardcode',
    videoQuality = 'original',
    encoderMode = 'cpu',
  } = config;
  const isSoftMux = outputMode === 'softmux';

  // 获取视频分辨率，用于显式设置 original_size
  // 防止滤镜重新初始化时因自动检测失败而报错
  let originalSize = '';
  // 视频高度：用于 4K 档 CRF 自适应偏移
  let videoHeight = 0;
  // 视频总时长（秒），用于在 progress.percent 不可用时自算合并进度（issue #310）
  let totalDurationSec = 0;
  try {
    const videoInfo = await getVideoInfo(videoPath);
    if (videoInfo.width > 0 && videoInfo.height > 0) {
      originalSize = `:original_size=${videoInfo.width}x${videoInfo.height}`;
      videoHeight = videoInfo.height;
    }
    totalDurationSec = videoInfo.duration || 0;
  } catch (err) {
    logMessage(
      `获取视频分辨率失败，跳过 original_size 设置: ${err}`,
      'warning',
    );
  }
  // ffprobe 不可用时（应用未打包 ffprobe），用打包的 ffmpeg 探测分辨率/时长兜底
  if (videoHeight <= 0) {
    const probed = await probeResolutionViaFfmpeg(videoPath);
    if (probed) {
      videoHeight = probed.height;
      if (!originalSize) {
        originalSize = `:original_size=${probed.width}x${probed.height}`;
      }
      if (totalDurationSec <= 0 && probed.durationSec > 0) {
        totalDurationSec = probed.durationSec;
      }
      logMessage(
        `ffmpeg 探测到分辨率: ${probed.width}x${probed.height}`,
        'info',
      );
    }
  }

  // 硬字幕烧录：读取字幕内容，决定走「预生成 ASS 管线」还是「ASS 输入 force_style 覆盖」
  let subtitleContent = '';
  let useAssPipeline = false;
  if (!isSoftMux) {
    try {
      subtitleContent = fs.readFileSync(subtitlePath, 'utf-8');
      useAssPipeline = !isAssInput(subtitlePath, subtitleContent);
    } catch (readErr) {
      logMessage(
        `读取字幕内容失败，回退 subtitles 滤镜路径: ${readErr}`,
        'warning',
      );
    }
  }

  // 如果字幕路径包含特殊字符（如单引号），则复制到临时目录使用安全文件名
  // 这是最可靠的方式，因为 ffmpeg 的滤镜字符串解析对特殊字符的处理在
  // 不同版本、不同平台、不同库封装下行为可能不一致
  // 软字幕封装走普通 input 参数（不经滤镜字符串解析），无需安全副本；
  // ASS 预生成管线写入的临时文件本身文件名安全，同样无需安全副本
  let actualSubPath = subtitlePath;
  let tmpSubPath: string | null = null;
  if (!isSoftMux && !useAssPipeline && pathNeedsSafeCopy(subtitlePath)) {
    tmpSubPath = createSafeSubtitleCopy(subtitlePath);
    actualSubPath = tmpSubPath;
  }

  logMessage(
    `开始合并字幕（${isSoftMux ? '软字幕封装' : '硬字幕烧录'}）: ${videoPath}`,
    'info',
  );
  logMessage(`字幕文件: ${subtitlePath}`, 'info');
  if (tmpSubPath) {
    logMessage(`使用临时字幕文件: ${tmpSubPath}`, 'info');
  }
  logMessage(`输出文件: ${outputPath}`, 'info');

  // 发送初始进度
  onProgress?.({
    percent: 0,
    timeMark: '00:00:00',
    targetSize: 0,
    status: 'processing',
  });

  let tmpAssPath: string | null = null;

  /**
   * 执行一次 ffmpeg 合成（encoding=null 表示软字幕封装）。
   * 失败仅 reject 原始错误（用户取消 reject MERGE_CANCELLED 并发 idle 进度）；
   * 最终 error 进度与临时文件清理由外层编排负责（硬件失败回退需复用临时文件重试）。
   */
  const runAttempt = (encoding: ResolvedVideoEncoding | null) =>
    new Promise<string>((resolve, reject) => {
      mergeCancelled = false;
      let command: ReturnType<typeof ffmpeg>;
      if (!encoding) {
        // 软字幕封装：全流复制 + 字幕流转 srt 进 mkv，秒级完成无画质损失
        command = ffmpeg(videoPath).input(subtitlePath).outputOptions([
          '-map',
          '0',
          '-map',
          '1',
          '-c',
          'copy', // 视频/音频流直接复制
          '-c:s',
          'srt', // 字幕流统一转 srt（mkv 原生支持；ass/vtt 自动转换）
          '-disposition:s:0',
          'default', // 字幕轨默认开启
          '-y',
        ]);
      } else {
        // 硬件编码器仅接受 8-bit 4:2:0：滤镜链末尾统一转 nv12（CPU 路径不变）
        const videoFilter = encoding.needsNv12
          ? `${subtitleFilter},format=nv12`
          : subtitleFilter;
        logMessage(`video filter: ${videoFilter}`, 'info');

        // 烧录必然重编码视频：显式指定编码器与画质参数，不依赖 ffmpeg 隐式默认
        // （issue #331）。音频仍直接复制不动。
        const outputOptions = [
          ...encoding.args,
          '-c:a',
          'copy', // 保持音频编码不变
        ];
        // MP4 系容器：moov box 前置，支持边下边播/秒开拖动
        if (FASTSTART_EXTENSIONS.has(path.extname(outputPath).toLowerCase())) {
          outputOptions.push('-movflags', '+faststart');
        }
        outputOptions.push('-y'); // 覆盖输出文件

        command = ffmpeg(videoPath)
          .videoFilters(videoFilter)
          .outputOptions(outputOptions);
      }

      command
        .on('start', (cmd) => {
          logMessage(`FFmpeg 命令: ${cmd}`, 'info');
        })
        // 从 ffmpeg 解析到的输入时长兜底总时长：不依赖 ffprobe（本应用未配置 ffprobe，
        // getVideoInfo 在缺失 ffprobe 的环境会失败，导致 totalDurationSec=0、进度恒为 0%）。
        .on('codecData', (data: { duration?: string }) => {
          const parsed = timemarkToSeconds(data?.duration || '');
          if (parsed > 0) {
            totalDurationSec = parsed;
            logMessage(
              `codecData 输入时长: ${data.duration} (${parsed}s)`,
              'info',
            );
          }
        })
        .on('progress', (progress) => {
          let percent = progress.percent;
          if (
            (percent === undefined ||
              percent === null ||
              Number.isNaN(percent) ||
              percent <= 0) &&
            totalDurationSec > 0 &&
            progress.timemark
          ) {
            percent =
              (timemarkToSeconds(progress.timemark) / totalDurationSec) * 100;
          }
          percent = Math.max(percent || 0, 0);
          logMessage(`合并进度: ${percent.toFixed(1)}%`, 'info');
          onProgress?.({
            percent: Math.min(percent, 99),
            timeMark: progress.timemark || '00:00:00',
            targetSize: progress.targetSize || 0,
            status: 'processing',
          });
        })
        .on('end', () => {
          currentMergeCommand = null;
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
          currentMergeCommand = null;
          // 用户取消：清理半成品、静默复位（不发 error 进度，不算失败）
          if (mergeCancelled) {
            mergeCancelled = false;
            cleanupPartialOutput(outputPath);
            logMessage('字幕合并已取消', 'warning');
            onProgress?.({
              percent: 0,
              timeMark: '',
              targetSize: 0,
              status: 'idle',
            });
            reject(new Error(MERGE_CANCELLED));
            return;
          }
          reject(err);
        });

      currentMergeCommand = command;
      command.save(outputPath);
    });

  // 最终失败（无回退或回退也失败）统一上报 error 进度
  const reportError = (err: Error) => {
    logMessage(`字幕合并失败: ${err.message}`, 'error');
    onProgress?.({
      percent: 0,
      timeMark: '',
      targetSize: 0,
      status: 'error',
      errorMessage: err.message,
    });
  };

  let subtitleFilter = '';
  try {
    if (isSoftMux) {
      try {
        return await runAttempt(null);
      } catch (err) {
        if (!(err instanceof Error && err.message === MERGE_CANCELLED)) {
          reportError(err as Error);
        }
        throw err;
      }
    }

    // 硬字幕烧录：构建字幕滤镜（重试时复用）
    if (useAssPipeline) {
      // 预生成 ASS 管线（SRT/VTT/LRC）：样式完整承载在生成的 ASS 文档里，
      // 显式 PlayRes + ScaledBorderAndShadow，语义确定；与预览共用同一生成逻辑。
      const { assContent, effectiveStyle } = buildAssForSubtitle(
        subtitleContent,
        subtitlePath,
        style,
      );
      try {
        tmpAssPath = writeTempAssFile(assContent);
      } catch (writeErr) {
        throw new Error(`写入临时 ASS 文件失败: ${writeErr}`);
      }
      logMessage(`ASS Style: ${buildAssStyleLine(effectiveStyle)}`, 'info');
      subtitleFilter = `ass='${escapeSubtitlePath(tmpAssPath)}'`;
    } else {
      // ASS/SSA 输入：尊重其自带样式结构，维持 subtitles + force_style 覆盖路径。
      // 中文乱码兜底：字幕含 CJK 时，确保最终字体「文件确实存在且含 CJK 字形」。
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

      const forceStyle = buildForceStyle(effectiveStyle);
      const escapedSubPath = escapeSubtitlePath(actualSubPath);
      subtitleFilter = `subtitles='${escapedSubPath}'${originalSize}:force_style='${forceStyle}'`;
    }
    logMessage(`subtitle filter: ${subtitleFilter}`, 'info');

    // 按编码方式解析编码器与画质参数（hardware 不可用/估算失败在内部回落 libx264）
    const encoding = await resolveVideoEncoding({
      encoderMode,
      videoQuality,
      videoHeight,
      videoPath,
      durationSec: totalDurationSec,
    });

    try {
      return await runAttempt(encoding);
    } catch (err) {
      const error = err as Error;
      // 用户取消：按既有流程静默复位，不触发回退
      if (error.message === MERGE_CANCELLED) {
        throw error;
      }
      // 硬件编码失败：清理半成品，自动回退 libx264 从头重跑（仅一次）
      if (encoding.encoder !== 'libx264') {
        cleanupPartialOutput(outputPath);
        logMessage(
          `硬件编码(${encoding.encoder})失败，自动切换 CPU 编码重试: ${error.message}`,
          'warning',
        );
        onProgress?.({
          percent: 0,
          timeMark: '00:00:00',
          targetSize: 0,
          status: 'processing',
          hwFallback: true,
        });
        const cpuEncoding = buildCpuEncoding(videoQuality, videoHeight);
        try {
          return await runAttempt(cpuEncoding);
        } catch (retryErr) {
          const retryError = retryErr as Error;
          if (retryError.message !== MERGE_CANCELLED) {
            reportError(retryError);
          }
          throw retryError;
        }
      }
      reportError(error);
      throw error;
    }
  } finally {
    // 清理临时文件（成功、失败、取消均清理；回退重试期间保留复用）
    if (tmpSubPath) {
      cleanupTempSubtitle(tmpSubPath);
    }
    if (tmpAssPath) {
      cleanupTempSubtitle(tmpAssPath);
    }
  }
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
