/**
 * 参考音频质检管线的纯函数层（零 fs / electron / ffmpeg 依赖，test:dubbing 单测覆盖）。
 *
 * 三个阶段的决策逻辑都在这里：
 *  1. analyze  — 帧能量 + 语音段 → 质检报告（buildQualityReport / estimateSnrDb）
 *  2. suggest  — 语音段滑窗打分 → 推荐选段（suggestCloneSegment）
 *  3. prepare  — 静音压缩区间规划 + 自动增益（planSilenceCompression / computeGainDb）
 *
 * 文件/ffmpeg 编排在 cloneAudioPipeline.ts；两层以本文件导出的数据结构为合同。
 */
import type {
  CloneSegmentSuggestion,
  CloneTargetRange,
  VoiceQualityIssue,
  VoiceQualityReport,
} from '../../../types/voiceClone';

export interface SpeechSegmentMs {
  startMs: number;
  endMs: number;
}

/**
 * 帧级分析（20ms 粒度），由调用方从 PCM 样本算出。
 * 帧级数组使选区复检无需重读样本（sliceFrameAnalysis 直接切片）。
 */
export interface FrameAnalysis {
  frameMs: number;
  /** 每帧 RMS 电平（dBFS）。 */
  frameDb: number[];
  /** 每帧峰值电平（dBFS）。 */
  framePeakDb: number[];
  /** 每帧近满幅（|s| ≥ 0.985）样本数。 */
  frameClipped: number[];
  /** 整帧样本数（末帧可能不满）。 */
  frameSamples: number;
  /** 全局峰值电平（dBFS）。 */
  peakDb: number;
  /** 近满幅样本占比 0..1。 */
  clippingRatio: number;
}

// ── 阈值（质检分级与自动处理的单一来源）─────────────────────────────────────

/** 有效语音硬下限（ms）：两引擎共同下限，低于阻止创建。 */
export const CLONE_MIN_SPEECH_MS = 3000;
/** SNR 黄牌线（dB）：语音帧与噪声帧能量差低于此值提示「声音不清晰」。 */
export const CLONE_SNR_WARN_DB = 15;
/** 削波黄牌线（近满幅样本占比）。 */
export const CLONE_CLIPPING_WARN_RATIO = 0.01;
/** 低音量线（语音帧均值 dBFS）：低于此值 prepare 自动增益。 */
export const CLONE_LOW_VOLUME_DB = -30;
/** 自动增益的目标语音电平（dBFS）与峰值保护上限。 */
export const CLONE_GAIN_TARGET_DB = -20;
export const CLONE_GAIN_PEAK_CEILING_DB = -1;
export const CLONE_GAIN_MAX_DB = 20;
/** 语音占比黄牌线。 */
export const CLONE_SPEECH_RATIO_WARN = 0.6;
/** 长静音提示线（ms）与压缩参数。 */
export const CLONE_LONG_SILENCE_MS = 1500;
export const CLONE_SILENCE_COMPRESS_ABOVE_MS = 800;
export const CLONE_SILENCE_KEEP_MS = 300;
export const CLONE_EDGE_PAD_MS = 150;

// ── 帧分析 ──────────────────────────────────────────────────────────────────

/** Float32 样本 → 帧级分析（RMS dB / 峰值 / 削波）。 */
export function analyzeSampleFrames(
  samples: Float32Array,
  sampleRate: number,
  frameMs = 20,
): FrameAnalysis {
  const samplesPerFrame = Math.max(
    1,
    Math.round((sampleRate * frameMs) / 1000),
  );
  const frameCount = Math.ceil(samples.length / samplesPerFrame);
  const frameDb: number[] = [];
  const framePeakDb: number[] = [];
  const frameClipped: number[] = [];
  let peak = 0;
  let clipped = 0;
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * samplesPerFrame;
    const end = Math.min(samples.length, start + samplesPerFrame);
    let sumSquares = 0;
    let framePeak = 0;
    let frameClip = 0;
    for (let i = start; i < end; i += 1) {
      const s = samples[i];
      const abs = Math.abs(s);
      if (abs > framePeak) framePeak = abs;
      if (abs >= 0.985) frameClip += 1;
      sumSquares += s * s;
    }
    if (framePeak > peak) peak = framePeak;
    clipped += frameClip;
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    frameDb.push(20 * Math.log10(Math.max(rms, 1e-8)));
    framePeakDb.push(20 * Math.log10(Math.max(framePeak, 1e-8)));
    frameClipped.push(frameClip);
  }
  return {
    frameMs,
    frameDb,
    framePeakDb,
    frameClipped,
    frameSamples: samplesPerFrame,
    peakDb: 20 * Math.log10(Math.max(peak, 1e-8)),
    clippingRatio: samples.length > 0 ? clipped / samples.length : 0,
  };
}

/**
 * 帧分析切片（选区复检用）：帧级数组按区间切，峰值/削波按切片重算。
 * 区间坐标 = 帧分析源音频的时间轴（analyze 阶段即整文件坐标）。
 */
export function sliceFrameAnalysis(
  frames: FrameAnalysis,
  startMs: number,
  endMs: number,
): FrameAnalysis {
  const from = Math.max(0, Math.floor(startMs / frames.frameMs));
  const to = Math.min(frames.frameDb.length, Math.ceil(endMs / frames.frameMs));
  const frameDb = frames.frameDb.slice(from, to);
  const framePeakDb = frames.framePeakDb.slice(from, to);
  const frameClipped = frames.frameClipped.slice(from, to);
  // 不用 Math.max(...arr)：小时级音频的帧数超函数参数上限会栈溢出。
  let peakDb = -160;
  let clipped = 0;
  for (let i = 0; i < framePeakDb.length; i += 1) {
    if (framePeakDb[i] > peakDb) peakDb = framePeakDb[i];
    clipped += frameClipped[i];
  }
  const totalSamples = frameDb.length * frames.frameSamples;
  return {
    frameMs: frames.frameMs,
    frameDb,
    framePeakDb,
    frameClipped,
    frameSamples: frames.frameSamples,
    peakDb,
    clippingRatio: totalSamples > 0 ? clipped / totalSamples : 0,
  };
}

/**
 * 帧能量 → 归一化包络（binMs 一格，0..1；-60dB 地板线性映射后按全片
 * 峰值再归一）——整体偏轻的录音（远场课录实测 -21dB 语音）不做峰值归一
 * 时波形条只有 ~60% 高度、静默区几乎不可见，选区微调无从下手。
 */
export function energyEnvelope(frames: FrameAnalysis, binMs = 100): number[] {
  const perBin = Math.max(1, Math.round(binMs / frames.frameMs));
  const bins: number[] = [];
  let peak = 0;
  for (let i = 0; i < frames.frameDb.length; i += perBin) {
    let max = -Infinity;
    for (let j = i; j < Math.min(frames.frameDb.length, i + perBin); j += 1) {
      if (frames.frameDb[j] > max) max = frames.frameDb[j];
    }
    const v = Math.min(1, Math.max(0, (max + 60) / 60));
    if (v > peak) peak = v;
    bins.push(v);
  }
  if (peak > 0.05 && peak < 1) {
    for (let i = 0; i < bins.length; i += 1) bins[i] = bins[i] / peak;
  }
  return bins;
}

// ── 语音段工具 ──────────────────────────────────────────────────────────────

/**
 * 帧能量 → 语音段（能量法，silero VAD 不可用时的兜底）：
 * 自适应阈值（噪声底 15 分位 + 12dB，封顶语音峰 −6dB）、桥接 <200ms 短静音、
 * 丢弃 <120ms 语音碎片——与 subtitleTiming.energySpeechSegments 同参数，
 * 但以 FrameAnalysis 为输入（纯函数，零 fs / electron）。
 */
export function energySegmentsFromFrames(
  frames: FrameAnalysis,
): SpeechSegmentMs[] {
  const sorted = frames.frameDb
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const pick = (ratio: number) =>
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.round((sorted.length - 1) * ratio)),
      )
    ];
  const threshold = Math.max(Math.min(pick(0.15) + 12, pick(0.95) - 6), -55);

  const raw: SpeechSegmentMs[] = [];
  let runStart = -1;
  for (let i = 0; i < frames.frameDb.length; i += 1) {
    const isSpeech = frames.frameDb[i] >= threshold;
    if (isSpeech && runStart < 0) runStart = i;
    else if (!isSpeech && runStart >= 0) {
      raw.push({
        startMs: runStart * frames.frameMs,
        endMs: i * frames.frameMs,
      });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    raw.push({
      startMs: runStart * frames.frameMs,
      endMs: frames.frameDb.length * frames.frameMs,
    });
  }

  const bridged: SpeechSegmentMs[] = [];
  for (const seg of raw) {
    const last = bridged[bridged.length - 1];
    if (last && seg.startMs - last.endMs < 200) last.endMs = seg.endMs;
    else bridged.push({ ...seg });
  }
  return bridged.filter((s) => s.endMs - s.startMs >= 120);
}

/** 语音段裁剪到区间并归并（输入需按 start 升序）。 */
export function clipSegmentsToRange(
  segments: SpeechSegmentMs[],
  startMs: number,
  endMs: number,
): SpeechSegmentMs[] {
  const out: SpeechSegmentMs[] = [];
  for (const seg of segments) {
    const s = Math.max(seg.startMs, startMs);
    const e = Math.min(seg.endMs, endMs);
    if (e > s) out.push({ startMs: s, endMs: e });
  }
  return out;
}

function sumSpeechMs(segments: SpeechSegmentMs[]): number {
  return segments.reduce((acc, s) => acc + (s.endMs - s.startMs), 0);
}

/** 区间内最长静音（含首尾静音）。 */
export function longestSilenceMs(
  segments: SpeechSegmentMs[],
  startMs: number,
  endMs: number,
): number {
  if (segments.length === 0) return Math.max(0, endMs - startMs);
  let longest = segments[0].startMs - startMs;
  for (let i = 1; i < segments.length; i += 1) {
    longest = Math.max(longest, segments[i].startMs - segments[i - 1].endMs);
  }
  longest = Math.max(longest, endMs - segments[segments.length - 1].endMs);
  return Math.max(0, longest);
}

// ── SNR 估算 ────────────────────────────────────────────────────────────────

/**
 * SNR 估算（dB）：语音帧均能量 − 非语音帧均能量（能量域均值再转 dB）。
 * 近似值，够做「清晰/嘈杂」分级：干净录音 >25dB，嘈杂 <15dB。
 * 无非语音帧（全程说话）时返回 snrCeiling（无从估噪声底，视为达标）。
 */
export function estimateSnrDb(
  frames: FrameAnalysis,
  segments: SpeechSegmentMs[],
  rangeStartMs: number,
  snrCeiling = 40,
): number {
  let speechEnergy = 0;
  let speechCount = 0;
  let noiseEnergy = 0;
  let noiseCount = 0;
  for (let i = 0; i < frames.frameDb.length; i += 1) {
    const t = rangeStartMs + i * frames.frameMs + frames.frameMs / 2;
    const inSpeech = segments.some((s) => t >= s.startMs && t < s.endMs);
    const energy = Math.pow(10, frames.frameDb[i] / 10);
    if (inSpeech) {
      speechEnergy += energy;
      speechCount += 1;
    } else {
      noiseEnergy += energy;
      noiseCount += 1;
    }
  }
  if (speechCount === 0) return 0;
  if (noiseCount === 0) return snrCeiling;
  const speechDb = 10 * Math.log10(speechEnergy / speechCount);
  const noiseDb = 10 * Math.log10(noiseEnergy / noiseCount);
  return Math.min(snrCeiling, Math.max(0, speechDb - noiseDb));
}

/** 语音帧均电平（dBFS）：自动增益决策的输入（静音帧不摊薄均值）。 */
export function speechRmsDb(
  frames: FrameAnalysis,
  segments: SpeechSegmentMs[],
  rangeStartMs: number,
): number {
  let energy = 0;
  let count = 0;
  for (let i = 0; i < frames.frameDb.length; i += 1) {
    const t = rangeStartMs + i * frames.frameMs + frames.frameMs / 2;
    if (!segments.some((s) => t >= s.startMs && t < s.endMs)) continue;
    energy += Math.pow(10, frames.frameDb[i] / 10);
    count += 1;
  }
  if (count === 0) return -80;
  return 10 * Math.log10(energy / count);
}

// ── 质检报告 ────────────────────────────────────────────────────────────────

export interface QualityReportInput {
  rangeStartMs: number;
  rangeEndMs: number;
  /** 已裁剪到区间的语音段。 */
  segments: SpeechSegmentMs[];
  /** 区间内的帧分析。 */
  frames: FrameAnalysis;
  /** 引擎推荐区间（缺省不出 short-for-engine 黄牌）。 */
  target?: CloneTargetRange;
}

/** 选区质检：分级门槛的单一实现（error 阻止 / warning 放行 / info 已自动处理）。 */
export function buildQualityReport(
  input: QualityReportInput,
): VoiceQualityReport {
  const { rangeStartMs, rangeEndMs, segments, frames, target } = input;
  const durationMs = Math.max(0, rangeEndMs - rangeStartMs);
  const speechMs = sumSpeechMs(segments);
  const speechRatio = durationMs > 0 ? speechMs / durationMs : 0;
  const silenceMs = longestSilenceMs(segments, rangeStartMs, rangeEndMs);
  const rmsDb = speechRmsDb(frames, segments, rangeStartMs);
  const snrDb = estimateSnrDb(frames, segments, rangeStartMs);

  const issues: VoiceQualityIssue[] = [];
  if (speechMs === 0) {
    issues.push({ code: 'no-speech', severity: 'error' });
  } else if (speechMs < CLONE_MIN_SPEECH_MS) {
    issues.push({ code: 'too-short', severity: 'error', value: speechMs });
  } else if (target && speechMs < target.idealMinMs) {
    issues.push({
      code: 'short-for-engine',
      severity: 'warning',
      value: speechMs,
    });
  }
  if (speechMs > 0 && snrDb < CLONE_SNR_WARN_DB) {
    issues.push({
      code: 'low-snr',
      severity: 'warning',
      value: Math.round(snrDb),
    });
  }
  if (frames.clippingRatio > CLONE_CLIPPING_WARN_RATIO) {
    issues.push({
      code: 'clipping',
      severity: 'warning',
      value: Math.round(frames.clippingRatio * 1000) / 1000,
    });
  }
  if (speechMs > 0 && rmsDb < CLONE_LOW_VOLUME_DB) {
    issues.push({
      code: 'low-volume',
      severity: 'info',
      value: Math.round(rmsDb),
    });
  }
  if (speechMs > 0 && speechRatio < CLONE_SPEECH_RATIO_WARN) {
    issues.push({
      code: 'low-speech-ratio',
      severity: 'warning',
      value: Math.round(speechRatio * 100) / 100,
    });
  }
  if (silenceMs > CLONE_LONG_SILENCE_MS) {
    issues.push({ code: 'long-silence', severity: 'info', value: silenceMs });
  }

  const verdict = issues.some((i) => i.severity === 'error')
    ? 'poor'
    : issues.some((i) => i.severity === 'warning')
      ? 'fair'
      : 'good';

  return {
    durationMs,
    speechMs,
    speechRatio: Math.round(speechRatio * 1000) / 1000,
    longestSilenceMs: silenceMs,
    rmsDb: Math.round(rmsDb * 10) / 10,
    peakDb: Math.round(frames.peakDb * 10) / 10,
    clippingRatio: Math.round(frames.clippingRatio * 10000) / 10000,
    snrDb: Math.round(snrDb * 10) / 10,
    verdict,
    issues,
  };
}

// ── 自动选段 ────────────────────────────────────────────────────────────────

/**
 * 全文件语音帧电平的高位基准（90 分位 dB）：能量感知选段的参照系。
 * 相对参照（而非绝对阈值）适配整体偏轻的录音——最响亮的说话区仍拿满分。
 */
export function speechLevelReferenceDb(
  frames: FrameAnalysis,
  segments: SpeechSegmentMs[],
): number {
  const values: number[] = [];
  for (const seg of segments) {
    const from = Math.max(0, Math.floor(seg.startMs / frames.frameMs));
    const to = Math.min(
      frames.frameDb.length,
      Math.ceil(seg.endMs / frames.frameMs),
    );
    for (let i = from; i < to; i += 1) values.push(frames.frameDb[i]);
  }
  if (values.length === 0) return -30;
  values.sort((a, b) => a - b);
  return values[
    Math.min(values.length - 1, Math.round((values.length - 1) * 0.9))
  ];
}

/**
 * 滑窗打分推荐最佳选段：窗口锚定各语音段起点，向后吸收语音直到达到
 * 引擎推荐时长（idealMax）或触硬上限；窗口尾对齐语音段边界（不切词；
 * 单段本身超长时在段内按推荐上限截断——连续语音无边界可对齐）。
 * 得分 = 语音占比 × 语音量充足度 × 能量项 − 长静音惩罚：
 * - 充足度 = min(1, 语音量/推荐上限)，确保「更多语音」优先于「紧凑但短」；
 * - 能量项（携 frames 时）= 窗口语音电平相对全文件 90 分位的衰减
 *   （−4dB 内满分，−16dB 归零）——VAD 对气声/远场微弱人声也会判语音，
 *   纯占比会选中听不清的区域（2.4h 课录实测踩坑），能量项把选段拉回
 *   响亮清晰的说话区。无语音段返回 null。
 */
export function suggestCloneSegment(
  segments: SpeechSegmentMs[],
  totalMs: number,
  target: CloneTargetRange,
  frames?: FrameAnalysis,
): CloneSegmentSuggestion | null {
  if (segments.length === 0) return null;
  const referenceDb = frames ? speechLevelReferenceDb(frames, segments) : null;

  let best: CloneSegmentSuggestion | null = null;
  for (let i = 0; i < segments.length; i += 1) {
    const startMs = Math.max(0, segments[i].startMs - CLONE_EDGE_PAD_MS);
    let speech = 0;
    let endMs = segments[i].endMs;
    for (let j = i; j < segments.length; j += 1) {
      const segLen = segments[j].endMs - segments[j].startMs;
      const candidateEnd = Math.min(
        segments[j].endMs + CLONE_EDGE_PAD_MS,
        totalMs,
      );
      const windowLen = candidateEnd - startMs;
      if (windowLen > target.maxMs) {
        if (j > i) break;
        // 首段本身超长：段内截断到推荐上限。
        endMs = Math.min(startMs + target.idealMaxMs, totalMs);
        speech = Math.max(0, endMs - segments[j].startMs);
        break;
      }
      speech += segLen;
      endMs = candidateEnd;
      // 语音量达到推荐区间即收口（不贪长：过长参考劣化克隆质量）。
      if (speech >= target.idealMaxMs) break;
    }
    const windowMs = endMs - startMs;
    if (windowMs <= 0) continue;
    const clipped = clipSegmentsToRange(segments, startMs, endMs);
    const windowSpeech = sumSpeechMs(clipped);
    const ratio = windowSpeech / windowMs;
    const silence = longestSilenceMs(clipped, startMs, endMs);
    const sufficiency = Math.min(1, windowSpeech / target.idealMaxMs);
    let energyTerm = 1;
    if (frames && referenceDb !== null) {
      const windowFrames = sliceFrameAnalysis(frames, startMs, endMs);
      const windowDb = speechRmsDb(windowFrames, clipped, startMs);
      energyTerm = Math.min(
        1,
        Math.max(0, (windowDb - (referenceDb - 16)) / 12),
      );
    }
    const score =
      ratio * sufficiency * energyTerm -
      Math.max(0, silence - CLONE_SILENCE_COMPRESS_ABOVE_MS) / 10000;
    if (!best || score > best.score + 1e-6) {
      best = {
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        score: Math.round(score * 1000) / 1000,
      };
    }
  }
  return best;
}

// ── 定稿处理规划（prepare）──────────────────────────────────────────────────

export interface KeepInterval {
  startMs: number;
  endMs: number;
}

/**
 * 静音压缩区间规划：输入选区内语音段（选区相对坐标），输出保留区间序列——
 * 首尾静音收敛到 edgePad，内部 > compressAbove 的静音压缩为 keep
 * （语音尾后与下段语音前各留一半）。拼接后即为最终参考音频。
 */
export function planSilenceCompression(
  segments: SpeechSegmentMs[],
  rangeMs: number,
  opts?: {
    compressAboveMs?: number;
    keepMs?: number;
    edgePadMs?: number;
  },
): KeepInterval[] {
  const compressAbove =
    opts?.compressAboveMs ?? CLONE_SILENCE_COMPRESS_ABOVE_MS;
  const keep = opts?.keepMs ?? CLONE_SILENCE_KEEP_MS;
  const edgePad = opts?.edgePadMs ?? CLONE_EDGE_PAD_MS;
  if (segments.length === 0) {
    return rangeMs > 0 ? [{ startMs: 0, endMs: rangeMs }] : [];
  }

  const intervals: KeepInterval[] = [];
  let cursor = Math.max(0, segments[0].startMs - edgePad);
  let openStart = cursor;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const next = segments[i + 1];
    const segEnd = Math.min(rangeMs, seg.endMs);
    if (!next) {
      intervals.push({
        startMs: openStart,
        endMs: Math.min(rangeMs, segEnd + edgePad),
      });
      break;
    }
    const gap = next.startMs - segEnd;
    if (gap > compressAbove) {
      // 断开：语音尾后留 keep/2，下段语音前留 keep/2。
      intervals.push({ startMs: openStart, endMs: segEnd + keep / 2 });
      openStart = next.startMs - keep / 2;
    }
    cursor = segEnd;
  }
  return intervals
    .map((iv) => ({
      startMs: Math.max(0, Math.round(iv.startMs)),
      endMs: Math.min(rangeMs, Math.round(iv.endMs)),
    }))
    .filter((iv) => iv.endMs > iv.startMs);
}

/**
 * 自动增益（dB）：语音电平低于 CLONE_LOW_VOLUME_DB 时抬到目标电平，
 * 受峰值保护（增益后峰值 ≤ ceiling）与最大增益双重钳制；不需要增益返回 0。
 */
export function computeGainDb(rmsDb: number, peakDb: number): number {
  if (rmsDb >= CLONE_LOW_VOLUME_DB) return 0;
  const wanted = CLONE_GAIN_TARGET_DB - rmsDb;
  const peakRoom = CLONE_GAIN_PEAK_CEILING_DB - peakDb;
  const gain = Math.min(wanted, peakRoom, CLONE_GAIN_MAX_DB);
  return gain > 0 ? Math.round(gain * 10) / 10 : 0;
}
