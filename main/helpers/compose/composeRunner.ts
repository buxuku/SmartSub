/**
 * 统一合成引擎 · 执行层。
 *
 * 职责：把 ComposeConfig 解析为可执行计划（硬烧字幕滤镜/编码参数解析、临时文件），
 * 执行 prep 步骤与主 ffmpeg 命令（进度/取消/半成品清理），硬件编码失败自动回退
 * libx264 重跑一次（沿 subtitle-burn-encoding 既有要求，音轨配置保持不变）。
 *
 * 本模块从 subtitleMerger.mergeSubtitleToVideo 迁移并泛化（收敛前该函数只支持
 * 「字幕 × keep」两列）；字幕滤镜与样式助手仍留在 subtitleMerger（预览 IPC 共用）。
 */

import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { logMessage } from '../storeManager';
import { timemarkToSeconds } from '../fileUtils';
import type {
  ComposeConfig,
  EncoderMode,
  HwEncoderId,
  MergeProgress,
  VideoQuality,
} from '../../../types/subtitleMerge';
import {
  VIDEO_QUALITY_CRF,
  HW_QUALITY_MAPPING,
  VT_BITRATE_QUALITY_FACTOR,
} from '../../../types/subtitleMerge';
import {
  getHwAccelInfo,
  buildHwCqArgs,
  buildVtBitrateArgs,
} from '../hwEncoderDetector';
import { detectSubtitleFormatFromContent } from '../subtitleFormats';
import {
  MERGE_CANCELLED,
  buildAssForSubtitle,
  buildForceStyle,
  createSafeSubtitleCopy,
  cleanupTempSubtitle,
  escapeSubtitlePath,
  getVideoInfo,
} from '../subtitleMerger';
import { containsCJK, resolveBurnFontName } from '../fontResolver';
import { buildAssStyleLine } from '../assStyleBuilder';
import {
  buildComposePlan,
  type ComposePlan,
  type ComposePlanSubtitle,
} from './composeCommandBuilder';

const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegPath);

/** 4K（高度≥1800）在画质档位基准上 CRF +2：高像素密度下感知质量冗余，控制体积 */
const CRF_4K_HEIGHT_THRESHOLD = 1800;
const CRF_4K_ADJUSTMENT = 2;

/** VT 码率模式：总码率中视频占比估算系数（扣除音频等非视频流） */
const VT_AUDIO_DEDUCTION = 0.85;

/** 解析后的视频编码方案（hard 字幕分支用） */
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

/** 判断路径是否包含需要特殊处理的字符（滤镜字符串解析不可靠字符） */
function pathNeedsSafeCopy(filePath: string): boolean {
  return /['\[\];,]/.test(filePath);
}

/** ASS/SSA 输入走 force_style 覆盖路径；其它格式走预生成 ASS 管线 */
function isAssInput(subtitlePath: string, content: string): boolean {
  return detectSubtitleFormatFromContent(subtitlePath, content) === 'ass';
}

/** 硬烧字幕解析产物：计划输入 + 需清理的临时文件 + 回退所需上下文 */
interface PreparedHardSubtitle {
  plan: ComposePlanSubtitle;
  encoder: ResolvedVideoEncoding['encoder'];
  tempFiles: string[];
  videoHeight: number;
  videoQuality: VideoQuality;
}

/** 运行时挂载：runner 向队列暴露"杀当前 ffmpeg"的取消入口 */
export interface ComposeRunContext {
  jobId: string;
  onProgress?: (progress: MergeProgress) => void;
  /** 注册取消函数（每次 ffmpeg 启动前更新；队列 cancel 时调用） */
  setCancel: (cancel: () => void) => void;
}

/**
 * 执行一个合成作业。成功返回输出路径；用户取消抛 Error(MERGE_CANCELLED)；
 * 其余失败抛原始错误（最终 error 进度已在内部上报）。
 */
export async function runComposeJob(
  config: ComposeConfig,
  ctx: ComposeRunContext,
): Promise<string> {
  const { videoPath, outputPath, subtitle, audio } = config;
  const tempFiles: string[] = [];
  let cancelled = false;
  let currentCommand: ReturnType<typeof ffmpeg> | null = null;

  ctx.setCancel(() => {
    cancelled = true;
    try {
      currentCommand?.kill('SIGKILL');
      logMessage('合成作业已被用户取消', 'warning');
    } catch (error) {
      logMessage(`取消合成失败: ${error}`, 'warning');
    }
  });

  const emit = (progress: Omit<MergeProgress, 'jobId'>) => {
    ctx.onProgress?.({ ...progress, jobId: ctx.jobId });
  };

  emit({
    percent: 0,
    timeMark: '00:00:00',
    targetSize: 0,
    status: 'processing',
  });

  // 视频总时长（秒）：进度分母（progress.percent 不可用时按 timemark 自算）
  let totalDurationSec = 0;

  /** 执行一次 ffmpeg（prep 或主命令）。取消 → reject MERGE_CANCELLED。 */
  const runCommand = (
    build: () => ReturnType<typeof ffmpeg>,
    outPath: string,
    opts?: { reportProgress?: boolean },
  ) =>
    new Promise<void>((resolve, reject) => {
      if (cancelled) {
        reject(new Error(MERGE_CANCELLED));
        return;
      }
      const command = build();
      command
        .on('start', (cmd) => {
          logMessage(`FFmpeg 命令: ${cmd}`, 'info');
        })
        .on('codecData', (data: { duration?: string }) => {
          const parsed = timemarkToSeconds(data?.duration || '');
          if (parsed > 0) {
            totalDurationSec = parsed;
          }
        })
        .on('progress', (progress) => {
          if (!opts?.reportProgress) return;
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
          emit({
            percent: Math.min(percent, 99),
            timeMark: progress.timemark || '00:00:00',
            targetSize: progress.targetSize || 0,
            status: 'processing',
          });
        })
        .on('end', () => {
          currentCommand = null;
          resolve();
        })
        .on('error', (err) => {
          currentCommand = null;
          if (cancelled) {
            cleanupPartialOutput(outPath);
            reject(new Error(MERGE_CANCELLED));
            return;
          }
          cleanupPartialOutput(outPath);
          reject(err);
        });
      currentCommand = command;
      command.save(outPath);
    });

  /** 按计划组装并执行主命令 */
  const runPlan = (plan: ComposePlan) =>
    runCommand(
      () => {
        const command = ffmpeg(plan.inputs[0]);
        for (const input of plan.inputs.slice(1)) command.input(input);
        if (plan.videoFilter) {
          logMessage(`video filter: ${plan.videoFilter}`, 'info');
          command.videoFilters(plan.videoFilter);
        }
        if (plan.complexFilter) {
          logMessage(
            `filter_complex: ${plan.complexFilter.join('; ')}`,
            'info',
          );
          command.complexFilter(plan.complexFilter);
        }
        command.outputOptions(plan.outputOptions);
        return command;
      },
      outputPath,
      { reportProgress: true },
    );

  try {
    // ── 解析硬烧字幕（滤镜 + 编码参数），探测分辨率/时长 ─────────────────────
    let prepared: PreparedHardSubtitle | null = null;
    if (subtitle.mode === 'hard') {
      prepared = await prepareHardSubtitle(config, tempFiles, (sec) => {
        totalDurationSec = sec;
      });
    }

    const planSubtitle: ComposePlanSubtitle =
      subtitle.mode === 'hard'
        ? prepared!.plan
        : subtitle.mode === 'soft'
          ? { mode: 'soft', subtitlePath: subtitle.subtitlePath }
          : { mode: 'none' };

    const plan = buildComposePlan({
      videoPath,
      outputPath,
      subtitle: planSubtitle,
      audio,
    });

    // ── prep 步骤：addTrack 的配音轨预编码 aac ──────────────────────────────
    if (plan.prep) {
      tempFiles.push(plan.prep.dst);
      const { src, dst } = plan.prep;
      logMessage(`预编码配音轨: ${src} -> ${dst}`, 'info');
      await runCommand(
        () =>
          ffmpeg(src)
            .audioCodec('aac')
            .audioBitrate('192k')
            .outputOptions('-y'),
        dst,
      );
    }

    // ── 主命令（硬件编码失败自动回退 libx264 一次） ─────────────────────────
    try {
      await runPlan(plan);
    } catch (err) {
      const error = err as Error;
      if (error.message === MERGE_CANCELLED) throw error;
      if (prepared && prepared.encoder !== 'libx264') {
        cleanupPartialOutput(outputPath);
        logMessage(
          `硬件编码(${prepared.encoder})失败，自动切换 CPU 编码重试: ${error.message}`,
          'warning',
        );
        emit({
          percent: 0,
          timeMark: '00:00:00',
          targetSize: 0,
          status: 'processing',
          hwFallback: true,
        });
        const cpuEncoding = buildCpuEncoding(
          prepared.videoQuality,
          prepared.videoHeight,
        );
        const fallbackPlan = buildComposePlan({
          videoPath,
          outputPath,
          subtitle: {
            ...(prepared.plan as Extract<
              ComposePlanSubtitle,
              { mode: 'hard' }
            >),
            encoderArgs: cpuEncoding.args,
            needsNv12: cpuEncoding.needsNv12,
          },
          audio,
        });
        await runPlan(fallbackPlan);
      } else {
        throw error;
      }
    }

    logMessage('合成作业完成', 'info');
    emit({ percent: 100, timeMark: '', targetSize: 0, status: 'completed' });
    return outputPath;
  } catch (err) {
    const error = err as Error;
    if (error.message === MERGE_CANCELLED) {
      emit({ percent: 0, timeMark: '', targetSize: 0, status: 'idle' });
      throw error;
    }
    logMessage(`合成作业失败: ${error.message}`, 'error');
    emit({
      percent: 0,
      timeMark: '',
      targetSize: 0,
      status: 'error',
      errorMessage: error.message,
    });
    throw error;
  } finally {
    for (const file of tempFiles) {
      if (file.endsWith('.m4a')) {
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      } else {
        cleanupTempSubtitle(file);
      }
    }
  }
}

/**
 * 解析硬烧字幕：探测分辨率/时长 → 生成 ASS 或 force_style 滤镜 → 解析编码参数。
 * 从 mergeSubtitleToVideo 的 hardcode 前置段迁移，行为不变。
 */
async function prepareHardSubtitle(
  config: ComposeConfig,
  tempFiles: string[],
  onDuration: (sec: number) => void,
): Promise<PreparedHardSubtitle> {
  const { videoPath, subtitle } = config;
  if (subtitle.mode !== 'hard') {
    throw new Error('prepareHardSubtitle: subtitle.mode must be hard');
  }
  const {
    subtitlePath,
    style,
    videoQuality = 'original',
    encoderMode = 'cpu',
  } = subtitle;

  // 分辨率/时长探测（ffprobe → 打包 ffmpeg 兜底）
  let originalSize = '';
  let videoHeight = 0;
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
  if (totalDurationSec > 0) onDuration(totalDurationSec);

  // 字幕滤镜：预生成 ASS 管线（SRT/VTT/LRC）或 force_style 覆盖（ASS/SSA）
  let subtitleContent = '';
  let useAssPipeline = false;
  try {
    subtitleContent = fs.readFileSync(subtitlePath, 'utf-8');
    useAssPipeline = !isAssInput(subtitlePath, subtitleContent);
  } catch (readErr) {
    logMessage(
      `读取字幕内容失败，回退 subtitles 滤镜路径: ${readErr}`,
      'warning',
    );
  }

  let filter: string;
  if (useAssPipeline) {
    const { assContent, effectiveStyle } = buildAssForSubtitle(
      subtitleContent,
      subtitlePath,
      style,
    );
    let tmpAssPath: string;
    try {
      tmpAssPath = writeTempAssFile(assContent);
    } catch (writeErr) {
      throw new Error(`写入临时 ASS 文件失败: ${writeErr}`);
    }
    tempFiles.push(tmpAssPath);
    logMessage(`ASS Style: ${buildAssStyleLine(effectiveStyle)}`, 'info');
    filter = `ass='${escapeSubtitlePath(tmpAssPath)}'`;
  } else {
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
    let actualSubPath = subtitlePath;
    if (pathNeedsSafeCopy(subtitlePath)) {
      const tmpSubPath = createSafeSubtitleCopy(subtitlePath);
      tempFiles.push(tmpSubPath);
      actualSubPath = tmpSubPath;
    }
    const forceStyle = buildForceStyle(effectiveStyle);
    const escapedSubPath = escapeSubtitlePath(actualSubPath);
    filter = `subtitles='${escapedSubPath}'${originalSize}:force_style='${forceStyle}'`;
  }
  logMessage(`subtitle filter: ${filter}`, 'info');

  const encoding = await resolveVideoEncoding({
    encoderMode,
    videoQuality,
    videoHeight,
    videoPath,
    durationSec: totalDurationSec,
  });

  return {
    plan: {
      mode: 'hard',
      filter,
      encoderArgs: encoding.args,
      needsNv12: encoding.needsNv12,
    },
    encoder: encoding.encoder,
    tempFiles,
    videoHeight,
    videoQuality,
  };
}
