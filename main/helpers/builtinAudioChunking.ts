/**
 * 内置 whisper.cpp 引擎「超长音频分片转写」的纯逻辑（无 electron / fs / ffmpeg，便于 test:engines 单测）。
 *
 * 背景（12 小时视频转写秒崩，EXC_BREAKPOINT @ operator new）：addon 在 Electron 主进程内
 * 一次性 `pcmf32.resize(总样本数)`——16kHz f32 单声道下约 9.3 小时即产生 ≥2GiB 的单笔分配，
 * 被 Chromium PartitionAlloc 无条件 SIGTRAP（安全设计，不可关闭，且与空闲内存无关）；
 * whisper 内部 VAD 还会整段复制音频，长文件内存成倍放大。
 *
 * 方案：超过激活阈值的音频在 JS 侧按「均衡目标时长 + 静音对齐」切片，逐片调用 addon 后
 * 按偏移回拼 token / VAD 段 / 段级结果，喂给下游同一条成句管线（下游无感知）。
 * 切点选在目标位置 ±CUT_SEARCH_WINDOW_SECONDS 窗口内「最长静音 run 的中点」，
 * 保证不把一句完整的话切成两段；窗口内无可用静音（连续语流，极罕见）→ 退回目标位置。
 */
import {
  formatTime,
  parseTime,
  type NativeToken,
  type TokenTriple,
} from './subtitleSegmentation';

/** 单片目标时长（秒）：1 小时 ≈ 230MB float 缓冲，内存安全且模型重载开销可忽略。 */
export const BUILTIN_CHUNK_TARGET_SECONDS = 3600;
/**
 * 分片激活阈值（秒）：4 小时。常见长内容（电影/播客/讲座/赛事，≤3.5h）单次转写内存
 * ≤~3GB 且一直工作正常，保持原路径零行为变化；>4h（直播录像/整套课程）恰是内存压力
 * 真实出现的区间，且距 ~9.3h 的 PartitionAlloc 2GiB 崩溃红线留有 2.3 倍裕量
 * （WAV 头损坏按字节数估算时长有偏差也安全）。
 */
export const BUILTIN_CHUNK_ACTIVATE_SECONDS = 14400;
/** 切点搜索窗口半径（秒）：在目标切点 ±45s 内找静音；相对 1h 片长偏移可忽略。 */
export const CUT_SEARCH_WINDOW_SECONDS = 45;
/** 静音 run 最短时长（秒）：短于此视为词内间隙，不作为切点候选。 */
export const MIN_SILENCE_RUN_SECONDS = 0.3;

export interface ChunkPlanOptions {
  targetSeconds?: number;
  activateSeconds?: number;
}

/**
 * 均衡切点目标位置（秒）：时长 ≤ 激活阈值 → 空数组（不分片）；
 * 否则按 `ceil(duration/target)` 片数均分（避免贪心切法在结尾留超短尾片），
 * 返回 count-1 个内部切点，后续再做静音对齐微调。
 */
export function planEvenChunkTargets(
  durationSec: number,
  options: ChunkPlanOptions = {},
): number[] {
  const target = options.targetSeconds ?? BUILTIN_CHUNK_TARGET_SECONDS;
  const activate = options.activateSeconds ?? BUILTIN_CHUNK_ACTIVATE_SECONDS;
  if (!Number.isFinite(durationSec) || durationSec <= activate || target <= 0) {
    return [];
  }
  const count = Math.ceil(durationSec / target);
  if (count < 2) return [];
  const even = durationSec / count;
  const targets: number[] = [];
  for (let k = 1; k < count; k += 1) {
    targets.push(k * even);
  }
  return targets;
}

/**
 * 窗口静音判定阈值（dB）：窗口内最安静的 5% 帧视为真静音底噪，高出其 9dB 以内算静音帧，
 * 并封顶 -38dB——若整个窗口都是连续语音（p5 也是语音电平），封顶保证不会把较轻的语音帧
 * 误判成静音而切在句中；此时通常找不到合格静音 run，pickSilenceCut 退回目标位置。
 */
export function silenceThresholdDb(frameDb: number[]): number {
  const sorted = (frameDb ?? [])
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!sorted.length) return -55;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * 0.05)),
  );
  return Math.min(sorted[idx] + 9, -38);
}

export interface SilenceCutOptions {
  /** 静音 run 最短时长（秒），默认 MIN_SILENCE_RUN_SECONDS。 */
  minRunSeconds?: number;
  /** 显式静音阈值（dB）；缺省用 silenceThresholdDb(frameDb) 自适应。 */
  thresholdDb?: number;
}

/**
 * 在能量帧窗口内挑静音切点（返回绝对秒）：收集低于阈值、时长 ≥ minRun 的静音 run，
 * 取「最长者」（并列取离目标最近者）的中点——切在句间停顿正中，两侧词均不受损。
 * 无合格 run → 返回 targetSec（退化为精确切，极罕见）。
 */
export function pickSilenceCut(
  frameDb: number[],
  frameDurationSec: number,
  windowStartSec: number,
  targetSec: number,
  options: SilenceCutOptions = {},
): number {
  if (!frameDb?.length || !(frameDurationSec > 0)) return targetSec;
  const threshold = options.thresholdDb ?? silenceThresholdDb(frameDb);
  const minRun = options.minRunSeconds ?? MIN_SILENCE_RUN_SECONDS;
  const minFrames = Math.max(1, Math.round(minRun / frameDurationSec));

  interface Run {
    start: number;
    end: number; // 帧下标区间 [start, end)
  }
  const runs: Run[] = [];
  let runStart = -1;
  for (let i = 0; i < frameDb.length; i += 1) {
    const silent = frameDb[i] < threshold;
    if (silent && runStart < 0) runStart = i;
    else if (!silent && runStart >= 0) {
      runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push({ start: runStart, end: frameDb.length });

  let best: Run | null = null;
  let bestLen = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    const len = run.end - run.start;
    if (len < minFrames) continue;
    const midSec =
      windowStartSec + ((run.start + run.end) / 2) * frameDurationSec;
    const dist = Math.abs(midSec - targetSec);
    if (len > bestLen || (len === bestLen && dist < bestDist)) {
      best = run;
      bestLen = len;
      bestDist = dist;
    }
  }
  if (!best) return targetSec;
  return windowStartSec + ((best.start + best.end) / 2) * frameDurationSec;
}

/**
 * 切点 → 连续分片边界：过滤非法/越界切点并排序去重，跳过会产生 <1s 碎片的切点，
 * 首尾补齐 [0, durationSec]。
 */
export function boundariesFromCuts(
  durationSec: number,
  cuts: number[],
): Array<{ start: number; end: number }> {
  if (!(durationSec > 0)) return [];
  const valid = Array.from(
    new Set(
      (cuts ?? []).filter(
        (c) => Number.isFinite(c) && c > 0 && c < durationSec,
      ),
    ),
  ).sort((a, b) => a - b);
  const boundaries: Array<{ start: number; end: number }> = [];
  let prev = 0;
  for (const cut of valid) {
    if (cut - prev < 1 || durationSec - cut < 1) continue;
    boundaries.push({ start: prev, end: cut });
    prev = cut;
  }
  boundaries.push({ start: prev, end: durationSec });
  return boundaries;
}

/** addon 免费暴露的 VAD 段原始形态（毫秒）。 */
export interface RawVadSegment {
  t0: number;
  t1: number;
}

/** 逐 token 输出整体加偏移（毫秒）；时间非法的 token 原样保留（下游按无时间处理，不丢字）。 */
export function offsetNativeTokens(
  tokens: NativeToken[] | undefined,
  offsetMs: number,
): NativeToken[] {
  return (tokens ?? []).map((tok) => {
    const t0 = Number(tok?.t0);
    const t1 = Number(tok?.t1);
    return {
      ...tok,
      t0: Number.isFinite(t0) ? t0 + offsetMs : tok?.t0,
      t1: Number.isFinite(t1) ? t1 + offsetMs : tok?.t1,
    };
  });
}

/** VAD 段整体加偏移（毫秒）；非法段原样保留（vadSegmentsToSpeech 会过滤）。 */
export function offsetVadSegments(
  segments: RawVadSegment[] | undefined,
  offsetMs: number,
): RawVadSegment[] {
  return (segments ?? []).map((seg) => {
    const t0 = Number(seg?.t0);
    const t1 = Number(seg?.t1);
    return {
      t0: Number.isFinite(t0) ? t0 + offsetMs : seg?.t0,
      t1: Number.isFinite(t1) ? t1 + offsetMs : seg?.t1,
    };
  });
}

/**
 * 段级结果（[startStr, endStr, text]，旧加速包回退路径用）整体加偏移（秒）；
 * 时间不可解析的条目原样保留文本。
 */
export function offsetSegmentCues(
  cues: TokenTriple[] | undefined,
  offsetSec: number,
): TokenTriple[] {
  return (cues ?? []).map((cue): TokenTriple => {
    const start = parseTime(cue?.[0]);
    const end = parseTime(cue?.[1]);
    if (start === null || end === null) {
      return [cue?.[0] ?? '', cue?.[1] ?? '', cue?.[2] ?? ''];
    }
    return [
      formatTime(start + offsetSec),
      formatTime(end + offsetSec),
      cue?.[2] ?? '',
    ];
  });
}

/**
 * 分片进度 → 整体进度（0–99）：单片 progress（0–100）按片序线性折算；
 * 100 留给转写完成后的状态切换。
 */
export function chunkedProgressPercent(
  chunkIndex: number,
  chunkCount: number,
  progress: number,
): number {
  if (!(chunkCount > 0)) return 0;
  const p = Math.min(100, Math.max(0, Number(progress) || 0));
  const overall = ((chunkIndex + p / 100) / chunkCount) * 100;
  return Math.min(99, Math.max(0, Math.floor(overall)));
}
