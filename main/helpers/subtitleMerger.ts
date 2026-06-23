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
  SubtitleAlignment,
} from '../../types/subtitleMerge';
import { VIDEO_QUALITY_CRF } from '../../types/subtitleMerge';

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

// 纯拉丁字体（不含 CJK 字形）。中文字幕若用这些字体烧录，libass 找不到字形会渲染成
// 豆腐块/乱码（issue: mac 中文烧录乱码）。命中且字幕含 CJK 时回退到平台 CJK 字体。
const LATIN_ONLY_FONTS = new Set([
  'arial',
  'helvetica',
  'helvetica neue',
  'georgia',
  'times new roman',
  'verdana',
  'roboto',
  'impact',
  'tahoma',
  'courier new',
]);

/** 文本是否包含 CJK（中日韩）字符 */
function containsCJK(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(
    text,
  );
}

/** 选中字体是否为纯拉丁字体（无 CJK 字形） */
function isLatinOnlyFont(fontName: string): boolean {
  return LATIN_ONLY_FONTS.has((fontName || '').trim().toLowerCase());
}

/**
 * macOS 上「确有字体文件」的常见 CJK 字体（按优先级）。
 * 关键点：PingFang 在部分 macOS 上没有可被 fontconfig 索引的字体文件
 * （仅 CoreText 可见），libass 解析「PingFang SC」会回退到 Helvetica → 中文渲染成乱码。
 * 因此烧录前必须挑一个「文件确实存在」的 CJK 字体，按 family 名交给 libass。
 * family 名取自 libass/fontconfig 对相应文件的实际解析结果（已实测）。
 */
const MAC_CJK_FONTS: Array<{ name: string; files: string[] }> = [
  { name: 'PingFang SC', files: ['/System/Library/Fonts/PingFang.ttc'] },
  {
    name: 'Hiragino Sans GB',
    files: ['/System/Library/Fonts/Hiragino Sans GB.ttc'],
  },
  {
    name: 'Heiti SC',
    files: [
      '/System/Library/Fonts/STHeiti Medium.ttc',
      '/System/Library/Fonts/STHeiti Light.ttc',
    ],
  },
  {
    name: 'Songti SC',
    files: ['/System/Library/Fonts/Supplemental/Songti.ttc'],
  },
  {
    name: 'Arial Unicode MS',
    files: ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf'],
  },
];

let cachedMacCJKFont: string | null = null;

/** macOS：返回第一个字体文件确实存在的 CJK 字体名（结果缓存） */
function resolveMacCJKFont(): string {
  if (cachedMacCJKFont) return cachedMacCJKFont;
  const found = MAC_CJK_FONTS.find((f) =>
    f.files.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }),
  );
  cachedMacCJKFont = found?.name ?? 'Arial Unicode MS';
  return cachedMacCJKFont;
}

/** 该字体在 macOS 上是否为「文件存在」的已知 CJK 字体（可被 libass 正常解析） */
function isMacResolvableCJKFont(fontName: string): boolean {
  const norm = (fontName || '').trim().toLowerCase();
  const matched = MAC_CJK_FONTS.find((f) => f.name.toLowerCase() === norm);
  return Boolean(
    matched &&
      matched.files.some((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      }),
  );
}

/** 按运行平台返回一个稳定可用的 CJK 字体名 */
function getPlatformCJKFont(): string {
  switch (process.platform) {
    case 'darwin':
      return resolveMacCJKFont();
    case 'win32':
      return 'Microsoft YaHei';
    default:
      return 'Noto Sans CJK SC';
  }
}

// 备注：曾尝试给 libass 传 fontsdir 兜底，但实测打包版 ffmpeg 的默认 fontconfig
// 已能按 family 名解析系统 CJK 字体（含 Supplemental 目录），fontsdir 反而会触发
// 扫描整目录的无害告警（如 Apple Color Emoji 元数据读取失败），故移除。

/**
 * 为「含 CJK 的字幕」决定最终烧录字体：
 * - 不含 CJK：原样使用用户所选字体；
 * - macOS：所选字体若不是「文件存在的已知 CJK 字体」（含用户默认 PingFang 在本机缺失的情况），
 *   一律换成 resolveMacCJKFont() 解析出的可用 CJK 字体；
 * - 其它平台：仅当所选为纯拉丁字体时回退到平台 CJK 字体。
 */
function resolveBurnFontName(chosenFont: string, hasCJK: boolean): string {
  if (!hasCJK) return chosenFont;
  if (process.platform === 'darwin') {
    return isMacResolvableCJKFont(chosenFont)
      ? chosenFont
      : resolveMacCJKFont();
  }
  return isLatinOnlyFont(chosenFont) ? getPlatformCJKFont() : chosenFont;
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
  } = config;
  const isSoftMux = outputMode === 'softmux';

  // 获取视频分辨率，用于显式设置 original_size
  // 防止滤镜重新初始化时因自动检测失败而报错
  let originalSize = '';
  // 视频总时长（秒），用于在 progress.percent 不可用时自算合并进度（issue #310）
  let totalDurationSec = 0;
  try {
    const videoInfo = await getVideoInfo(videoPath);
    if (videoInfo.width > 0 && videoInfo.height > 0) {
      originalSize = `:original_size=${videoInfo.width}x${videoInfo.height}`;
    }
    totalDurationSec = videoInfo.duration || 0;
  } catch (err) {
    logMessage(
      `获取视频分辨率失败，跳过 original_size 设置: ${err}`,
      'warning',
    );
  }

  // 如果字幕路径包含特殊字符（如单引号），则复制到临时目录使用安全文件名
  // 这是最可靠的方式，因为 ffmpeg 的滤镜字符串解析对特殊字符的处理在
  // 不同版本、不同平台、不同库封装下行为可能不一致
  // 软字幕封装走普通 input 参数（不经滤镜字符串解析），无需安全副本
  let actualSubPath = subtitlePath;
  let tmpSubPath: string | null = null;
  if (!isSoftMux && pathNeedsSafeCopy(subtitlePath)) {
    tmpSubPath = createSafeSubtitleCopy(subtitlePath);
    actualSubPath = tmpSubPath;
  }

  return new Promise((resolve, reject) => {
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

    // 取消后删除写了一半的输出文件，不留半成品
    const cleanupPartialOutput = () => {
      try {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
          logMessage(`已删除未完成的输出文件: ${outputPath}`, 'info');
        }
      } catch (cleanupErr) {
        logMessage(`删除未完成输出文件失败: ${cleanupErr}`, 'warning');
      }
    };

    mergeCancelled = false;
    let command: ReturnType<typeof ffmpeg>;
    if (isSoftMux) {
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
      // 中文乱码兜底：字幕含 CJK 时，确保最终字体「文件确实存在且含 CJK 字形」。
      // 典型坑：用户默认字体 PingFang 在部分 mac 上无字体文件，libass 会回退到 Helvetica
      // 渲染成乱码（已实测）。这里换成本机存在的 CJK 字体（如 Hiragino Sans GB）。
      let effectiveStyle = style;
      try {
        const subtitleSample = fs.readFileSync(subtitlePath, 'utf-8');
        const hasCJK = containsCJK(subtitleSample);
        const burnFont = resolveBurnFontName(style.fontName, hasCJK);
        if (burnFont !== style.fontName) {
          effectiveStyle = { ...style, fontName: burnFont };
          logMessage(
            `字幕含中文，但所选字体「${style.fontName}」在本机不可用/无 CJK 字形，已改用「${burnFont}」`,
            'warning',
          );
        }
      } catch (readErr) {
        logMessage(`读取字幕用于字体检测失败（忽略）: ${readErr}`, 'warning');
      }

      const forceStyle = buildForceStyle(effectiveStyle);
      const escapedSubPath = escapeSubtitlePath(actualSubPath);
      const subtitlesFilter = `subtitles='${escapedSubPath}'${originalSize}:force_style='${forceStyle}'`;
      logMessage(`subtitles filter: ${subtitlesFilter}`, 'info');
      // 烧录必然重编码视频：显式指定 CRF 控制画质，避免沿用 libx264 默认(CRF23)
      // 造成肉眼可见的压缩与体积骤减（issue #331）。音频仍直接复制不动。
      const crf = VIDEO_QUALITY_CRF[videoQuality] ?? VIDEO_QUALITY_CRF.original;
      logMessage(
        `hardcode video quality: ${videoQuality} (crf=${crf})`,
        'info',
      );
      command = ffmpeg(videoPath)
        .videoFilters(subtitlesFilter)
        .outputOptions([
          '-crf',
          String(crf), // 画质档位 → libx264 CRF
          '-c:a',
          'copy', // 保持音频编码不变
          '-y', // 覆盖输出文件
        ]);
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
        // 清理临时文件
        if (tmpSubPath) {
          cleanupTempSubtitle(tmpSubPath);
        }
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
        // 清理临时文件
        if (tmpSubPath) {
          cleanupTempSubtitle(tmpSubPath);
        }
        // 用户取消：清理半成品、静默复位（不发 error 进度，不算失败）
        if (mergeCancelled) {
          mergeCancelled = false;
          cleanupPartialOutput();
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
        logMessage(`字幕合并失败: ${err.message}`, 'error');
        onProgress?.({
          percent: 0,
          timeMark: '',
          targetSize: 0,
          status: 'error',
          errorMessage: err.message,
        });
        reject(err);
      });

    currentMergeCommand = command;
    command.save(outputPath);
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
