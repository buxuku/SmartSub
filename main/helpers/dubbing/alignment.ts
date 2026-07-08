import type {
  AlignmentPlan,
  AlignmentPlanItem,
  AlignmentSpeedAction,
} from '../../../types/dubbing';
import {
  ALIGN_ONESHOT_THRESHOLD,
  ALIGN_OVERLONG_THRESHOLD,
} from '../../../types/dubbing';
import type { TtsSpeedControl } from '../../../types/ttsProvider';

/**
 * 时间轴对齐引擎（纯函数，零 I/O，test:dubbing 单测覆盖）。
 *
 * 五层防线中的第 1/2/3 层在此实现决策，第 4 层产出过长行清单：
 *   第 1 层 合成期 speed 预控制（decideSpeedAction，预估驱动）
 *   第 2 层 复测（recheckAfterSynthesis，实测驱动：本地重合成 / 云端 atempo）
 *   第 3 层 间隙借用（computeSlots：槽位 = 本条 start 到下条 start）
 *   第 4 层 过长行（> ALIGN_OVERLONG_THRESHOLD 全部标记，0 漏报）
 * 最终 buildAlignmentPlan 以实测时长做 cursor 走查，产出可直接驱动
 * audioPipeline.assembleTrack 的槽位规划（重叠 cue 按 start 顺延不撞车）。
 */

// ── 输入形状（与 types/dubbing.ts 的 DubbingCue 结构兼容，避免 main→types 强耦合）──

export interface AlignCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

// ── 槽位计算（第 3 层：间隙借用 + 重叠检测）─────────────────────────────────

export interface CueSlot {
  index: number;
  /** 原字幕起点（ms）。 */
  startMs: number;
  /** 原字幕终点（ms）——mix 模式轨道分配按原始区间划分。 */
  endMs: number;
  /** 可用槽位（ms）：到下条 start 的窗口（间隙并入）；重叠时回落自身时长。 */
  slotMs: number;
  /** 与下条时间轴交叠（下条 start 早于本条 end）。 */
  overlapNext: boolean;
}

/** 无媒体总时长时末条槽位的尾部余量（ms）。 */
export const DEFAULT_TAIL_PADDING_MS = 1000;

/**
 * 计算每条 cue 的可用槽位。输入无需有序，输出按 startMs 升序（同 start 按 index）。
 * - 间隙借用：slot = next.start − cur.start（静音间隙并入本条可用时长）；
 * - 末条：媒体总时长 − start；无媒体时长则自身时长 + tailPaddingMs；
 * - 重叠（next.start < cur.end）：本条不被挤压（slot 回落自身时长），
 *   冲突由拼接期「按 start 顺延后条」消解（见 buildAlignmentPlan）。
 */
export function computeSlots(
  cues: AlignCue[],
  opts?: { mediaDurationMs?: number; tailPaddingMs?: number },
): CueSlot[] {
  const tailPadding = opts?.tailPaddingMs ?? DEFAULT_TAIL_PADDING_MS;
  const ordered = [...cues].sort(
    (a, b) => a.startMs - b.startMs || a.index - b.index,
  );
  return ordered.map((cue, i) => {
    const ownDuration = Math.max(0, cue.endMs - cue.startMs);
    let windowMs: number;
    if (i < ordered.length - 1) {
      windowMs = ordered[i + 1].startMs - cue.startMs;
    } else if (
      opts?.mediaDurationMs !== undefined &&
      opts.mediaDurationMs > cue.startMs
    ) {
      windowMs = opts.mediaDurationMs - cue.startMs;
    } else {
      windowMs = ownDuration + tailPadding;
    }
    return {
      index: cue.index,
      startMs: cue.startMs,
      endMs: cue.endMs,
      slotMs: Math.max(windowMs, ownDuration),
      overlapNext: i < ordered.length - 1 && ordered[i + 1].startMs < cue.endMs,
    };
  });
}

// ── 时长预估与校准（第 1 层输入）───────────────────────────────────────────

/** 语速基准（字符/秒）。初始值来自 Phase 0 kokoro 实测（speed-curve.mjs）。 */
export interface SpeechRates {
  /** CJK 字符语速（字/秒）。 */
  cjkCharsPerSec: number;
  /** 其它（拉丁等）字符语速（字符/秒，含空格按字符计）。 */
  latinCharsPerSec: number;
}

export const DEFAULT_SPEECH_RATES: SpeechRates = {
  cjkCharsPerSec: 4.1,
  latinCharsPerSec: 17.3,
};

const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/**
 * 预估合成时长（ms）：CJK 与其它字符分开按语速基准折算后相加
 * （中英混排常见，单一基准会系统性偏差）。空白不计。
 */
export function estimateDurationMs(
  text: string,
  rates: SpeechRates = DEFAULT_SPEECH_RATES,
): number {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (CJK_RE.test(ch)) cjk++;
    else latin++;
  }
  const sec = cjk / rates.cjkCharsPerSec + latin / rates.latinCharsPerSec;
  return Math.round(sec * 1000);
}

/**
 * 运行期校准：以已合成行的 Σ实测/Σ预估 修正后续预估。
 * 纯数据对象 + 纯函数，状态由调用方（processor）持有。
 */
export interface RateCalibration {
  totalEstimatedMs: number;
  totalMeasuredMs: number;
}

export function createCalibration(): RateCalibration {
  return { totalEstimatedMs: 0, totalMeasuredMs: 0 };
}

/** 合成一行后回填（measured 应为该行 1.0x 等效时长：实测 × 已用 speed）。 */
export function updateCalibration(
  cal: RateCalibration,
  estimatedMs: number,
  measuredMs: number,
): RateCalibration {
  return {
    totalEstimatedMs: cal.totalEstimatedMs + estimatedMs,
    totalMeasuredMs: cal.totalMeasuredMs + measuredMs,
  };
}

/** 校准后的预估：样本不足（< 3s 预估量）时原样返回。 */
export function calibratedEstimate(
  estimatedMs: number,
  cal: RateCalibration,
): number {
  if (cal.totalEstimatedMs < 3000 || cal.totalMeasuredMs <= 0) {
    return estimatedMs;
  }
  return Math.round((estimatedMs * cal.totalMeasuredMs) / cal.totalEstimatedMs);
}

// ── 第 1 层：合成期 speed 预控制决策 ────────────────────────────────────────

export interface SpeedDecision {
  /** 合成用 speed（native/ssml 引擎；1 = 原速）。 */
  preSpeed: number;
  /** 需要合成后复测（第 2 层）。 */
  needsRecheck: boolean;
  /** 预估即超红线（过长行候选；最终以实测复核）。 */
  estimatedOverlong: boolean;
  /** 预估 ratio（时长/槽位）。 */
  ratio: number;
}

/**
 * ratio 四档决策树（design 6.3）：
 *   ≤1.0 原速；≤1.15 预控制一次到位；≤1.5 预控制 + 复测；>1.5 过长候选。
 * speedControl='none' 的引擎无预控制，一律原速合成后走 atempo 复测。
 */
export function decideSpeedAction(
  estimatedMs: number,
  slotMs: number,
  speedControl: TtsSpeedControl,
): SpeedDecision {
  if (estimatedMs <= 0) {
    return {
      preSpeed: 1,
      needsRecheck: false,
      estimatedOverlong: false,
      ratio: 0,
    };
  }
  const ratio = slotMs > 0 ? estimatedMs / slotMs : Number.POSITIVE_INFINITY;
  const canPreControl = speedControl === 'native' || speedControl === 'ssml';

  if (ratio <= 1.0) {
    return {
      preSpeed: 1,
      needsRecheck: false,
      estimatedOverlong: false,
      ratio,
    };
  }
  if (!canPreControl) {
    // 无预控制：原速合成，复测阶段统一 atempo。
    return {
      preSpeed: 1,
      needsRecheck: true,
      estimatedOverlong: ratio > ALIGN_OVERLONG_THRESHOLD,
      ratio,
    };
  }
  if (ratio <= ALIGN_ONESHOT_THRESHOLD) {
    return {
      preSpeed: ratio,
      needsRecheck: false,
      estimatedOverlong: false,
      ratio,
    };
  }
  if (ratio <= ALIGN_OVERLONG_THRESHOLD) {
    return {
      preSpeed: ratio,
      needsRecheck: true,
      estimatedOverlong: false,
      ratio,
    };
  }
  // 过长候选：预控制封顶红线（保音质），残余交给复测/人工。
  return {
    preSpeed: ALIGN_OVERLONG_THRESHOLD,
    needsRecheck: true,
    estimatedOverlong: true,
    ratio,
  };
}

// ── 第 2 层：复测决策（实测驱动）────────────────────────────────────────────

/** 重合成的 speed 余量：speed 非线性（实测缩短量 < 理论 1/speed），上浮 5% 补偿。 */
export const RESYNTH_MARGIN = 1.05;

export type RecheckDecision =
  | { type: 'fit'; padMs: number }
  | { type: 'resynthesize'; speed: number }
  | { type: 'atempo'; factor: number }
  | { type: 'overlong'; requiredFactor: number; residualFactor: number };

/**
 * 实测复测：
 * - 落在槽位内 → fit（补静音）；
 * - 综合倍率（已用 speed × 残余倍率）≤ 红线：
 *     canResynthesize（本地，合成免费）→ 改 speed 重合成（带 5% 余量）；
 *     否则（云端，重合成花钱）→ 对已产出 wav atempo；
 * - 超红线 → overlong 进人工清单（不自动施加超红线变速）。
 */
export function recheckAfterSynthesis(
  measuredMs: number,
  slotMs: number,
  appliedSpeed: number,
  opts: { canResynthesize: boolean; alreadyResynthesized?: boolean },
): RecheckDecision {
  if (measuredMs <= 0) return { type: 'fit', padMs: Math.max(0, slotMs) };
  if (slotMs <= 0) {
    return {
      type: 'overlong',
      requiredFactor: Number.POSITIVE_INFINITY,
      residualFactor: Number.POSITIVE_INFINITY,
    };
  }
  const residual = measuredMs / slotMs;
  if (residual <= 1.001) {
    return { type: 'fit', padMs: Math.max(0, slotMs - measuredMs) };
  }
  const requiredFactor = appliedSpeed * residual;
  if (requiredFactor > ALIGN_OVERLONG_THRESHOLD + 1e-9) {
    return { type: 'overlong', requiredFactor, residualFactor: residual };
  }
  if (opts.canResynthesize && !opts.alreadyResynthesized) {
    return {
      type: 'resynthesize',
      speed: Math.min(
        requiredFactor * RESYNTH_MARGIN,
        ALIGN_OVERLONG_THRESHOLD,
      ),
    };
  }
  return { type: 'atempo', factor: residual };
}

// ── 最终槽位规划（cursor 走查：顺延消解重叠/溢出）──────────────────────────

export interface FinalCue {
  index: number;
  startMs: number;
  /** 实测最终时长（ms，含一切变速后）。 */
  durationMs: number;
  action: AlignmentSpeedAction;
  /** 复测后仍超红线且未被用户接受（进清单）。 */
  overlong: boolean;
}

/**
 * 产出最终 AlignmentPlan：按 start 顺序、逐轨 cursor 走查。
 * - 轨道分配（overlapMode='mix'）：按**原字幕区间**贪心划分——放入
 *   「已放原区间末端 ≤ 本行原 start」的最小编号轨道，放不下开新轨；
 *   'shift'（默认）全部落轨 0。分配以原始时间轴为准（而非合成时长），
 *   保证无重叠字幕在两种模式下产出等价规划（合成溢出仍走轨内顺延语义）。
 * - 轨内 targetStart = max(原 start, 该轨 cursor)：重叠（或 shift 模式溢出）
 *   的后条顺延；truncate 模式占用时长封顶槽位（时间轴锚定），shift 模式
 *   占用完整时长、后续同轨整体顺延（配套导出顺延字幕）。
 */
export function buildAlignmentPlan(
  finals: FinalCue[],
  slots: CueSlot[],
  opts: {
    overflow: 'truncate' | 'shift';
    overlapMode?: 'shift' | 'mix';
  },
): AlignmentPlan {
  const slotByIndex = new Map(slots.map((s) => [s.index, s]));
  const ordered = [...finals].sort((a, b) => {
    const sa = slotByIndex.get(a.index);
    const sb = slotByIndex.get(b.index);
    return (
      (sa?.startMs ?? a.startMs) - (sb?.startMs ?? b.startMs) ||
      a.index - b.index
    );
  });
  const mix = opts.overlapMode === 'mix';

  const items: AlignmentPlanItem[] = [];
  const overlongIndexes: number[] = [];
  const overlapIndexes: number[] = [];
  /** 各轨的原字幕区间末端（轨道分配用）与拼接 cursor（顺延消解用）。 */
  const laneOrigEnds: number[] = [];
  const laneCursors: number[] = [];

  for (const cue of ordered) {
    const slot = slotByIndex.get(cue.index);
    const slotMs = slot?.slotMs ?? Math.max(0, cue.durationMs);
    const origStart = slot?.startMs ?? cue.startMs;
    const origEnd = Math.max(
      origStart,
      slot?.endMs ?? cue.startMs + Math.max(0, cue.durationMs),
    );

    let lane = 0;
    if (mix) {
      lane = laneOrigEnds.findIndex((end) => end <= origStart);
      if (lane < 0) lane = laneOrigEnds.length;
    }
    if (laneOrigEnds.length <= lane) {
      laneOrigEnds.length = lane + 1;
      laneCursors.length = lane + 1;
      laneOrigEnds[lane] = 0;
      laneCursors[lane] = 0;
    }
    laneOrigEnds[lane] = Math.max(laneOrigEnds[lane], origEnd);

    const targetStartMs = Math.max(cue.startMs, laneCursors[lane]);
    const shifted = targetStartMs > cue.startMs;
    const durationMs =
      opts.overflow === 'truncate'
        ? Math.min(cue.durationMs, slotMs)
        : cue.durationMs;
    const ratio =
      slotMs > 0 ? cue.durationMs / slotMs : Number.POSITIVE_INFINITY;
    const overlap = Boolean(slot?.overlapNext) || shifted;

    items.push({
      index: cue.index,
      targetStartMs,
      durationMs,
      slotMs,
      ratio,
      action: cue.action,
      padMs: Math.max(0, slotMs - durationMs),
      overlong: cue.overlong,
      overlap,
      lane,
    });
    if (cue.overlong) overlongIndexes.push(cue.index);
    if (overlap) overlapIndexes.push(cue.index);
    laneCursors[lane] = targetStartMs + durationMs;
  }

  return { items, overlongIndexes, overlapIndexes };
}

/**
 * 顺延字幕时间轴：按规划的实际占用生成新 cue 时间（导出顺延版 srt 用）。
 * 返回 [index, startMs, endMs]，文本由调用方按 index 回填。
 */
export function shiftedTimeline(
  plan: AlignmentPlan,
): Array<{ index: number; startMs: number; endMs: number }> {
  return plan.items.map((item) => ({
    index: item.index,
    startMs: item.targetStartMs,
    endMs: item.targetStartMs + item.durationMs,
  }));
}
