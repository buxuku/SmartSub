/**
 * 统一合成引擎 · 纯函数命令构建器。
 *
 * 把「字幕（none/soft/hard）× 音轨（keep/replace/mix/addTrack）」矩阵组装为
 * 单次 ffmpeg 执行的结构化计划（ComposePlan）。本模块零 I/O、零 electron 依赖，
 * 可在纯 node 下单测（args 断言，无需真实执行 ffmpeg）。
 *
 * 字幕封装显式映射视频、音频和字幕，避免复制不兼容数据流；audio 三形态在 subtitle=none 下沿用
 * dubbing/audioPipeline 的 replaceAudioTrack / duckMixIntoVideo / addAudioTrack
 * 一致（addTrack 保持「先预编 aac 再全流拷贝混流」两步形制，避免 -c:a:N
 * 输出序号在原视频多音轨时错位）。
 */

import * as path from 'path';
import type { EmbeddedSubtitleStream } from '../embeddedSubtitleParser';

/** 硬烧字幕的解析后输入：滤镜与编码参数由调用方（runner）解析完成后传入。 */
export interface ComposeHardSubtitle {
  mode: 'hard';
  /** 完整字幕滤镜（`ass='…'` 或 `subtitles='…':force_style='…'`），不含 format=nv12 */
  filter: string;
  /** 从 -c:v 起的完整视频编码参数（libx264 或硬件编码器 + 画质参数） */
  encoderArgs: string[];
  /** 硬件编码器仅接受 8-bit 4:2:0：滤镜链末尾追加 format=nv12 */
  needsNv12: boolean;
}

export type ComposePlanSubtitle =
  | { mode: 'none' }
  | { mode: 'soft'; subtitlePath: string }
  | ComposeHardSubtitle;

export type ComposePlanAudio =
  | { mode: 'keep' }
  | {
      mode: 'replace' | 'mix' | 'addTrack';
      trackPath: string;
      /** mix 模式原声压低强度（sidechaincompress ratio），缺省 8 */
      duckRatio?: number;
    };

export interface ComposePlanInput {
  videoPath: string;
  outputPath: string;
  subtitle: ComposePlanSubtitle;
  audio: ComposePlanAudio;
  embeddedSubtitles?: EmbeddedSubtitleStream[];
  hasOriginalAudio?: boolean;
}

/** addTrack 模式的前置步骤：配音轨预编码为 aac 临时文件（主命令全流 -c copy） */
export interface ComposePrepStep {
  kind: 'encodeAac';
  src: string;
  dst: string;
}

/** 结构化执行计划：runner 按此组装 fluent-ffmpeg 命令 */
export interface ComposePlan {
  /** 按序 -i 输入（input 0 恒为视频） */
  inputs: string[];
  /** 简单视频滤镜（-vf；与 complexFilter 互斥） */
  videoFilter?: string;
  /** -filter_complex 行（音频混流/硬烧+混音的视频标签路径） */
  complexFilter?: string[];
  /** 全部输出选项（-map/-c/…，含结尾 -y） */
  outputOptions: string[];
  /** 主命令前的准备步骤（当前仅 addTrack 的 aac 预编码） */
  prep?: ComposePrepStep;
}

/** MP4 系容器（支持 -movflags +faststart） */
const FASTSTART_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

/** 配音轨统一编码参数（与既有配音导出一致） */
const AAC_ARGS = ['-c:a', 'aac', '-b:a', '192k'];

const DEFAULT_DUCK_RATIO = 8;

/** The dual-audio workflow retains its MKV container contract. */
export function composePlanRequiresMkv(input: {
  subtitle: { mode: ComposePlanSubtitle['mode'] };
  audio: { mode: ComposePlanAudio['mode'] };
}): boolean {
  return input.audio.mode === 'addTrack';
}

/**
 * ducking 混音滤镜（与既有 duckMixIntoVideo 相同语义）：
 * 配音一分为二（sidechain 触发源 + 混音源），原声被压低后与配音叠加。
 */
function buildDuckMixFilters(duckRatio: number): string[] {
  return [
    '[1:a]asplit=2[sc][dub]',
    `[0:a][sc]sidechaincompress=threshold=0.03:ratio=${duckRatio}:attack=20:release=300[bg]`,
    '[bg][dub]amix=inputs=2:duration=first:normalize=0[mix]',
  ];
}

/**
 * 组装合成计划。纯函数：不触盘、不探测；硬烧滤镜与编码参数须由调用方先解析。
 *
 * @param tempTag addTrack 预编码临时文件名标记（缺省时间戳；测试注入固定值）
 */
export function buildComposePlan(
  input: ComposePlanInput,
  opts?: { tempTag?: string },
): ComposePlan {
  const { videoPath, outputPath, subtitle } = input;
  const audio: ComposePlanAudio =
    input.audio.mode === 'mix' && input.hasOriginalAudio === false
      ? { ...input.audio, mode: 'replace' }
      : input.audio;
  const extension = path.extname(outputPath).toLowerCase();
  if (subtitle.mode === 'soft' && !['.mkv', '.mp4'].includes(extension)) {
    throw new Error('Soft subtitles require an MKV or MP4 output container');
  }
  const softSubtitleTail = [
    extension === '.mp4' ? '-c:s' : '-c:s:0',
    extension === '.mp4' ? 'mov_text' : 'srt',
    '-disposition:s:0',
    'default',
  ];
  if (
    subtitle.mode === 'soft' &&
    extension === '.mp4' &&
    input.embeddedSubtitles?.some((stream) => !stream.isText)
  ) {
    throw new Error('MP4 cannot retain bitmap subtitle tracks; choose MKV');
  }
  for (const stream of input.embeddedSubtitles || []) {
    if (stream.isDefault)
      softSubtitleTail.push(
        `-disposition:s:${stream.subIndex + 1}`,
        '-default',
      );
  }

  if (subtitle.mode === 'none' && audio.mode === 'keep') {
    throw new Error('compose: nothing to do (subtitle=none, audio=keep)');
  }

  const hasTrack = audio.mode !== 'keep';
  const faststart =
    subtitle.mode === 'hard' &&
    FASTSTART_EXTENSIONS.has(path.extname(outputPath).toLowerCase());

  // addTrack：预编 aac 临时文件，主命令用它替代原始配音轨输入
  let prep: ComposePrepStep | undefined;
  let trackInput = hasTrack ? audio.trackPath : null;
  if (audio.mode === 'addTrack') {
    const dst = path.join(
      path.dirname(outputPath),
      `.dub-track-${opts?.tempTag ?? Date.now()}.m4a`,
    );
    prep = { kind: 'encodeAac', src: audio.trackPath, dst };
    trackInput = dst;
  }

  // 输入顺序恒定：视频 0 → 配音轨 1（若有）→ 软封字幕文件（若有）
  const inputs = [videoPath];
  if (trackInput) inputs.push(trackInput);
  if (subtitle.mode === 'soft') inputs.push(subtitle.subtitlePath);
  const softSubIndex = inputs.length - 1;

  const duckRatio =
    audio.mode === 'mix' ? (audio.duckRatio ?? DEFAULT_DUCK_RATIO) : 0;

  let videoFilter: string | undefined;
  let complexFilter: string[] | undefined;
  const opt: string[] = [];

  if (subtitle.mode === 'hard') {
    const chain = subtitle.needsNv12
      ? `${subtitle.filter},format=nv12`
      : subtitle.filter;
    if (audio.mode === 'mix') {
      // -vf 与 -filter_complex 不能并用：视频滤镜并入 complex 图
      complexFilter = [
        `[0:v]${chain}[vout]`,
        ...buildDuckMixFilters(duckRatio),
      ];
      opt.push('-map', '[vout]', '-map', '[mix]');
      opt.push(...subtitle.encoderArgs, ...AAC_ARGS);
    } else if (audio.mode === 'replace') {
      videoFilter = chain;
      opt.push('-map', '0:v', '-map', '1:a');
      opt.push(...subtitle.encoderArgs, ...AAC_ARGS);
    } else if (audio.mode === 'addTrack') {
      videoFilter = chain;
      // 原音轨全部保留 + 预编 aac 配音轨；音频统一流拷贝（无 -c:a:N 序号错位）
      opt.push('-map', '0:v', '-map', '0:a?', '-map', '1:a');
      opt.push(...subtitle.encoderArgs, '-c:a', 'copy');
    } else {
      // Explicit maps retain every original audio track without also auto-selecting
      // an embedded subtitle that a player could render over the burned text.
      videoFilter = chain;
      opt.push('-map', '0:v', '-map', '0:a?');
      opt.push(...subtitle.encoderArgs, '-c:a', 'copy');
    }
    if (faststart) opt.push('-movflags', '+faststart');
  } else if (subtitle.mode === 'soft') {
    // The new subtitle is s:0; original subtitles follow it, unchanged in MKV.
    // MP4 text tracks use mov_text. Data and attachments are not MP4 media tracks.
    if (audio.mode === 'keep') {
      opt.push('-map', '0:v', '-map', '0:a?');
    } else if (audio.mode === 'replace') {
      opt.push('-map', '0:v', '-map', '1:a');
    } else if (audio.mode === 'mix') {
      complexFilter = buildDuckMixFilters(duckRatio);
      opt.push('-map', '0:v', '-map', '[mix]');
    } else {
      opt.push('-map', '0:v', '-map', '0:a?', '-map', '1:a');
    }
    opt.push('-map', `${softSubIndex}:s:0`, '-map', '0:s?');
    if (extension === '.mkv') opt.push('-map', '0:t?');
    opt.push('-c', 'copy');
    if (audio.mode === 'replace' || audio.mode === 'mix') opt.push(...AAC_ARGS);
    opt.push(...softSubtitleTail);
    if (extension === '.mp4') opt.push('-movflags', '+faststart');
  } else {
    // subtitle=none：与收敛前 audioPipeline 三形态逐参数一致
    if (audio.mode === 'replace') {
      opt.push('-map', '0:v', '-map', '1:a', '-map', '0:s?');
      opt.push('-c:v', 'copy', '-c:s', 'copy', ...AAC_ARGS);
    } else if (audio.mode === 'mix') {
      complexFilter = buildDuckMixFilters(duckRatio);
      opt.push('-map', '0:v', '-map', '[mix]', '-map', '0:s?');
      opt.push('-c:v', 'copy', '-c:s', 'copy', ...AAC_ARGS);
    } else if (audio.mode === 'addTrack') {
      opt.push('-map', '0', '-map', '1:a', '-c', 'copy');
    }
  }

  opt.push('-y');

  return {
    inputs,
    videoFilter,
    complexFilter,
    outputOptions: opt,
    prep,
  };
}

/** 计划的可读摘要（日志用）：输入清单 + 滤镜 + 输出选项 */
export function composePlanSummary(plan: ComposePlan): string {
  const parts = [
    `inputs=[${plan.inputs.join(' | ')}]`,
    plan.videoFilter ? `vf=${plan.videoFilter}` : null,
    plan.complexFilter
      ? `filter_complex=${plan.complexFilter.join('; ')}`
      : null,
    `output=[${plan.outputOptions.join(' ')}]`,
    plan.prep ? `prep=encodeAac(${plan.prep.src} -> ${plan.prep.dst})` : null,
  ];
  return parts.filter(Boolean).join(' ');
}
