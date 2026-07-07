/**
 * 配音时长对齐引擎（纯函数，引擎无关）。
 * 固化二轮实验结论（见 explorations §6.6 / design D2）：
 * 静音修剪 → chunk 划分 → 统一变速决策 → 非重叠拼装规划 → 可选响度归一。
 * atempo 执行与 PCM 拼装由 ttsProcessor 调用 ffmpeg 完成；本模块只产出规划。
 */

export interface DubCue {
  start: number;
  end: number;
  text: string;
}

/** 单句合成产物（已静音修剪后的时长）。 */
export interface TrimmedSegment {
  index: number;
  /** 修剪后语音时长（秒）。 */
  speechDurationSec: number;
}

export type DurationStrategy = 'strict' | 'balanced' | 'natural';

export interface AlignmentParams {
  /** 可接受变速上限；超过则尝试丢弃句间间隙重算。 */
  acceptSpeed: number;
  /** 硬变速上限；超过则钳制并允许尾部漂移（natural 可视为不设限）。 */
  maxSpeed: number;
  /** 相邻两段最小间隔（秒）。 */
  guardSec: number;
  /** chunk 末句允许向后溢出的宽限（秒）。 */
  tailToleranceSec: number;
  /** 句间间隙 ≥ 此值时切开为新 chunk（秒）。 */
  chunkGapSec: number;
  /** natural 策略：钳制后仍超长则接受漂移，不强行压入时间窗。 */
  allowUnlimitedDrift: boolean;
}

export interface ChunkSpeedPlan {
  speed: number;
  clampedSpeed: number;
  keepGaps: boolean;
  chunkAvailableSec: number;
  speechTotalSec: number;
  gapsTotalSec: number;
}

export interface PlacedCue {
  index: number;
  cue: DubCue;
  /** 实际音频落点起点（秒）。 */
  start: number;
  /** atempo 后时长（秒）。 */
  durationSec: number;
  /** 建议 atempo 因子（≥1 加速压缩；1 不变）。 */
  atempoFactor: number;
}

const DEFAULT_PARAMS: Record<DurationStrategy, AlignmentParams> = {
  strict: {
    acceptSpeed: 1.2,
    maxSpeed: 1.5,
    guardSec: 0.08,
    tailToleranceSec: 1.5,
    chunkGapSec: 1.5,
    allowUnlimitedDrift: false,
  },
  balanced: {
    acceptSpeed: 1.2,
    maxSpeed: 1.4,
    guardSec: 0.08,
    tailToleranceSec: 1.5,
    chunkGapSec: 1.5,
    allowUnlimitedDrift: false,
  },
  natural: {
    acceptSpeed: 1.1,
    maxSpeed: 1.15,
    guardSec: 0.08,
    tailToleranceSec: 2.0,
    chunkGapSec: 1.5,
    allowUnlimitedDrift: true,
  },
};

export function getAlignmentParams(
  strategy: DurationStrategy = 'balanced',
): AlignmentParams {
  return { ...DEFAULT_PARAMS[strategy] };
}

/**
 * 静音修剪：20ms 窗 RMS < peak×2% 视为静音；语音区首尾各留 40ms。
 */
export function trimSilence(
  samples: Float32Array,
  sampleRate: number,
): Float32Array {
  if (samples.length === 0) return samples;
  const win = Math.round(sampleRate * 0.02);
  if (win <= 0) return samples;

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  if (peak === 0) return samples;

  const thresh = peak * 0.02;
  const nWin = Math.floor(samples.length / win);
  let first = -1;
  let last = -1;
  for (let w = 0; w < nWin; w++) {
    let sum = 0;
    for (let i = w * win; i < (w + 1) * win; i++)
      sum += samples[i] * samples[i];
    if (Math.sqrt(sum / win) > thresh) {
      if (first < 0) first = w;
      last = w;
    }
  }
  if (first < 0) return samples;

  const s = Math.max(0, first * win - Math.round(sampleRate * 0.04));
  const e = Math.min(
    samples.length,
    (last + 1) * win + Math.round(sampleRate * 0.04),
  );
  return samples.subarray(s, e);
}

/** 按句间大间隙切开 chunk；返回每 chunk 的 cue 下标列表。 */
export function splitCueIndices(cues: DubCue[], chunkGapSec = 1.5): number[][] {
  if (cues.length === 0) return [];
  const chunks: number[][] = [[0]];
  for (let i = 1; i < cues.length; i++) {
    const gap = cues[i].start - cues[i - 1].end;
    if (gap >= chunkGapSec) {
      chunks.push([i]);
    } else {
      chunks[chunks.length - 1].push(i);
    }
  }
  return chunks;
}

function sumGaps(cues: DubCue[]): number {
  let total = 0;
  for (let i = 1; i < cues.length; i++) {
    total += Math.max(0, cues[i].start - cues[i - 1].end);
  }
  return total;
}

/**
 * chunk 内统一变速决策：优先保留句间间隙，超 ACCEPT 则丢弃间隙重算；
 * 有富余保持原速；硬上限 MAX；natural 允许漂移。
 */
export function planChunkSpeed(
  cues: DubCue[],
  speechDurations: number[],
  params: AlignmentParams,
): ChunkSpeedPlan {
  if (cues.length === 0) {
    return {
      speed: 1,
      clampedSpeed: 1,
      keepGaps: true,
      chunkAvailableSec: 0,
      speechTotalSec: 0,
      gapsTotalSec: 0,
    };
  }

  const speechTotalSec = speechDurations.reduce((s, d) => s + d, 0);
  const gapsTotalSec = sumGaps(cues);
  const chunkAvailableSec =
    cues[cues.length - 1].end +
    params.tailToleranceSec -
    cues[0].start -
    params.guardSec * (cues.length - 1);

  let keepGaps = true;
  let speed =
    chunkAvailableSec > 0
      ? (speechTotalSec + gapsTotalSec) / chunkAvailableSec
      : 1;

  if (speed > params.acceptSpeed) {
    keepGaps = false;
    speed = chunkAvailableSec > 0 ? speechTotalSec / chunkAvailableSec : speed;
  }
  if (speed < 1) speed = 1;

  let clampedSpeed = params.allowUnlimitedDrift
    ? Math.min(speed, params.maxSpeed)
    : Math.min(speed, params.maxSpeed);

  // strict/balanced：钳制后若仍塞不进可用窗，保持钳制值并接受漂移（不重叠）
  if (!params.allowUnlimitedDrift && speed > params.maxSpeed) {
    clampedSpeed = params.maxSpeed;
  }

  return {
    speed,
    clampedSpeed,
    keepGaps,
    chunkAvailableSec,
    speechTotalSec,
    gapsTotalSec,
  };
}

/**
 * 非重叠拼装规划：游标推进，产出每句落点与 atempo 后时长。
 * 绝不重叠；允许相对原时间轴漂移。
 */
export function planPlacements(
  cues: DubCue[],
  speechDurations: number[],
  speedPlan: ChunkSpeedPlan,
  params: AlignmentParams,
): PlacedCue[] {
  if (cues.length === 0) return [];

  const factor = speedPlan.clampedSpeed;
  const placed: PlacedCue[] = [];

  for (let i = 0; i < cues.length; i++) {
    const rawDur = speechDurations[i];
    const durationSec = factor > 1.001 ? rawDur / factor : rawDur;
    let start: number;

    if (i === 0) {
      start = cues[0].start;
    } else if (speedPlan.keepGaps) {
      const gap = Math.max(0, cues[i].start - cues[i - 1].end) / factor;
      start = Math.max(
        placed[i - 1].start +
          placed[i - 1].durationSec +
          Math.max(params.guardSec, gap),
        cues[i].start,
      );
    } else {
      start = Math.max(
        placed[i - 1].start + placed[i - 1].durationSec + params.guardSec,
        cues[i].start,
      );
    }

    // 浮点安全：绝不早于前句结束 + guard（防止 cue.start 拉回造成微量重叠）
    if (i > 0) {
      const floor =
        placed[i - 1].start + placed[i - 1].durationSec + params.guardSec;
      if (start < floor) start = floor;
    }

    placed.push({
      index: i,
      cue: cues[i],
      start,
      durationSec,
      atempoFactor: factor > 1.001 ? factor : 1,
    });
  }

  return placed;
}

/** 全轨对齐规划：多 chunk 独立决策后按全局下标合并。 */
export function planDubbingTimeline(
  cues: DubCue[],
  speechDurations: number[],
  strategy: DurationStrategy = 'balanced',
  paramsOverride?: Partial<AlignmentParams>,
): PlacedCue[] {
  const params = { ...getAlignmentParams(strategy), ...paramsOverride };
  const chunks = splitCueIndices(cues, params.chunkGapSec);
  const result: PlacedCue[] = [];

  for (const indices of chunks) {
    const chunkCues = indices.map((i) => cues[i]);
    const chunkDurs = indices.map((i) => speechDurations[i]);
    const speedPlan = planChunkSpeed(chunkCues, chunkDurs, params);
    const chunkPlaced = planPlacements(chunkCues, chunkDurs, speedPlan, params);
    for (let j = 0; j < chunkPlaced.length; j++) {
      let item = { ...chunkPlaced[j], index: indices[j] };
      // 跨 chunk 衔接：新 chunk 首句不得侵入上一 chunk 末句
      if (j === 0 && result.length > 0) {
        const prev = result[result.length - 1];
        const floor = prev.start + prev.durationSec + params.guardSec;
        if (item.start < floor) item = { ...item, start: floor };
      }
      result.push(item);
    }
  }

  return result.sort((a, b) => a.index - b.index);
}

/** 段级 RMS 归一到目标 dBFS（默认 -20）。 */
export function normalizeSegmentRms(
  samples: Float32Array,
  targetDbfs = -20,
): Float32Array {
  if (samples.length === 0) return samples;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms < 1e-10) return samples;

  const target = 10 ** (targetDbfs / 20);
  const gain = target / rms;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

export function secondsToSrtTimestamp(t: number): string {
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(t % 60)).padStart(2, '0');
  const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${ms}`;
}

/** 由落点规划生成重排时间轴 SRT 文本。 */
export function placedCuesToSrt(placed: PlacedCue[]): string {
  return placed
    .map((p, i) => {
      const end = p.start + p.durationSec;
      return `${i + 1}\n${secondsToSrtTimestamp(p.start)} --> ${secondsToSrtTimestamp(end)}\n${p.cue.text}\n`;
    })
    .join('\n');
}

export interface OverlapReport {
  overlapTotalSec: number;
  maxStartDriftSec: number;
  monotonic: boolean;
}

/** 断言/诊断：重叠总量、最大起点漂移、时间轴单调性。 */
export function analyzePlacements(placed: PlacedCue[]): OverlapReport {
  let overlapTotalSec = 0;
  let maxStartDriftSec = 0;
  let monotonic = true;

  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    maxStartDriftSec = Math.max(maxStartDriftSec, p.start - p.cue.start);
    const next = placed[i + 1];
    if (next) {
      const overlap = Math.max(0, p.start + p.durationSec - next.start);
      overlapTotalSec += overlap;
      if (next.start < p.start) monotonic = false;
    }
  }

  return { overlapTotalSec, maxStartDriftSec, monotonic };
}
