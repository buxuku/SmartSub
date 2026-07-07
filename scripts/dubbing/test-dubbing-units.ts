/**
 * 配音对齐引擎纯逻辑单元测试（无 Electron / 无模型依赖）。
 *
 * 覆盖 main/helpers/dubbing 的可单测部分：
 *  - alignment: 槽位计算（间隙借用/末条/重叠/零长/空文件）、时长预估与校准、
 *    ratio 四档决策树、复测决策（重合成 vs atempo vs 过长零漏报）、
 *    最终规划 cursor 走查（顺延/截断/补静音）、顺延字幕时间轴
 *  - audioPipeline: buildAtempoChain 链分解（纯函数部分）
 *
 * 运行：npm run test:dubbing
 */
import {
  computeSlots,
  estimateDurationMs,
  createCalibration,
  updateCalibration,
  calibratedEstimate,
  decideSpeedAction,
  recheckAfterSynthesis,
  buildAlignmentPlan,
  shiftedTimeline,
  DEFAULT_SPEECH_RATES,
  DEFAULT_TAIL_PADDING_MS,
  RESYNTH_MARGIN,
  type AlignCue,
} from '../../main/helpers/dubbing/alignment';
import { buildAtempoChain } from '../../main/helpers/dubbing/audioPipeline';
import {
  ALIGN_ONESHOT_THRESHOLD,
  ALIGN_OVERLONG_THRESHOLD,
} from '../../types/dubbing';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${name}`);
  }
}

function cue(
  index: number,
  startMs: number,
  endMs: number,
  text = 'x',
): AlignCue {
  return { index, startMs, endMs, text };
}

// ── computeSlots：间隙借用 / 末条 / 重叠 / 零长 / 空文件 ─────────────────────

{
  // 间隙借用：A 1000–3000，B start 5000 → A 槽位 4000（2s 字幕 + 2s 间隙）
  const slots = computeSlots([cue(0, 1000, 3000), cue(1, 5000, 7000)], {
    mediaDurationMs: 10000,
  });
  eq(slots[0].slotMs, 4000, 'slots: 间隙并入本条槽位');
  eq(slots[0].overlapNext, false, 'slots: 无重叠不标记');
  // 末条：媒体总长 10000 − start 5000 = 5000
  eq(slots[1].slotMs, 5000, 'slots: 末条槽位 = 媒体总长 − start');
}

{
  // 末条无媒体时长：自身时长 + 尾部余量
  const slots = computeSlots([cue(0, 0, 2000)]);
  eq(
    slots[0].slotMs,
    2000 + DEFAULT_TAIL_PADDING_MS,
    'slots: 无媒体时长末条回落自身+余量',
  );
}

{
  // 重叠：A 0–5000，B 3000–8000 → A 不被挤压（槽位=自身 5000），标记 overlapNext
  const slots = computeSlots([cue(0, 0, 5000), cue(1, 3000, 8000)], {
    mediaDurationMs: 10000,
  });
  eq(slots[0].slotMs, 5000, 'slots: 重叠时本条槽位回落自身时长(不挤压)');
  eq(slots[0].overlapNext, true, 'slots: 重叠标记在前条');
  eq(slots[1].slotMs, 7000, 'slots: 重叠后条槽位正常(到媒体末尾)');
}

{
  // 零长 cue：槽位 = 到下条 start 的窗口
  const slots = computeSlots([cue(0, 1000, 1000), cue(1, 2000, 3000)], {
    mediaDurationMs: 5000,
  });
  eq(slots[0].slotMs, 1000, 'slots: 零长 cue 仍拿到到下条的窗口');
  // 完全同刻零长 + 有长下条:窗口为 0,回落自身 0
  const slots2 = computeSlots([cue(0, 1000, 1000), cue(1, 1000, 3000)], {
    mediaDurationMs: 5000,
  });
  eq(slots2[0].slotMs, 0, 'slots: 同刻零长槽位为 0(交由决策树判过长)');
}

{
  // 空文件与乱序输入
  eq(computeSlots([]), [], 'slots: 空输入产出空规划');
  const slots = computeSlots([cue(1, 5000, 6000), cue(0, 1000, 2000)], {
    mediaDurationMs: 8000,
  });
  eq(
    slots.map((s) => s.index),
    [0, 1],
    'slots: 输出按 startMs 排序',
  );
}

// ── estimateDurationMs / 校准 ────────────────────────────────────────────────

{
  // 30 个 CJK 字 ≈ 30/4.1 s;60 拉丁字符 ≈ 60/17.3 s;混排相加
  const zh = '你'.repeat(30);
  const en = 'a'.repeat(60);
  eq(
    estimateDurationMs(zh),
    Math.round((30 / 4.1) * 1000),
    'estimate: 纯中文按 cjk 基准',
  );
  eq(
    estimateDurationMs(en),
    Math.round((60 / 17.3) * 1000),
    'estimate: 纯英文按 latin 基准',
  );
  eq(
    estimateDurationMs(zh + ' ' + en),
    Math.round((30 / 4.1 + 60 / 17.3) * 1000),
    'estimate: 混排分开折算相加(空白不计)',
  );
  eq(estimateDurationMs(''), 0, 'estimate: 空文本为 0');
  ok(
    DEFAULT_SPEECH_RATES.cjkCharsPerSec === 4.1,
    'estimate: zh 基准来自实测 4.1 字/s',
  );
}

{
  // 校准:样本不足原样;足量后按 Σ实测/Σ预估 修正
  let cal = createCalibration();
  eq(calibratedEstimate(1000, cal), 1000, 'calibration: 无样本原样返回');
  cal = updateCalibration(cal, 4000, 5000); // 实测比预估长 25%
  eq(calibratedEstimate(1000, cal), 1250, 'calibration: 足量样本后放大 25%');
  cal = updateCalibration(cal, 4000, 3000);
  eq(calibratedEstimate(1000, cal), 1000, 'calibration: 双向样本回归 1.0');
}

// ── decideSpeedAction:四档决策树 ────────────────────────────────────────────

{
  // ≤1.0:原速
  eq(
    decideSpeedAction(900, 1000, 'native'),
    { preSpeed: 1, needsRecheck: false, estimatedOverlong: false, ratio: 0.9 },
    'decide: ratio≤1 原速无复测',
  );
  // (1.0, 1.15]:预控制一次到位
  const d2 = decideSpeedAction(1100, 1000, 'native');
  eq(
    [d2.preSpeed, d2.needsRecheck, d2.estimatedOverlong],
    [1.1, false, false],
    'decide: ratio≤1.15 预控制一次到位',
  );
  // (1.15, 1.5]:预控制 + 复测
  const d3 = decideSpeedAction(1400, 1000, 'native');
  eq(
    [d3.preSpeed, d3.needsRecheck, d3.estimatedOverlong],
    [1.4, true, false],
    'decide: ratio≤1.5 预控制+复测',
  );
  // >1.5:过长候选,预控制封顶红线
  const d4 = decideSpeedAction(2000, 1000, 'native');
  eq(
    [d4.preSpeed, d4.needsRecheck, d4.estimatedOverlong],
    [ALIGN_OVERLONG_THRESHOLD, true, true],
    'decide: ratio>1.5 过长候选,speed 封顶红线',
  );
  // 边界值恰在阈值上
  eq(
    decideSpeedAction(1150, 1000, 'native').needsRecheck,
    false,
    'decide: ratio=1.15 归一次到位档',
  );
  eq(
    decideSpeedAction(1500, 1000, 'native').estimatedOverlong,
    false,
    'decide: ratio=1.5 不判过长',
  );
}

{
  // speedControl='none':无预控制,超槽一律原速+复测
  const d = decideSpeedAction(1300, 1000, 'none');
  eq(
    [d.preSpeed, d.needsRecheck],
    [1, true],
    'decide: none 引擎原速合成走复测 atempo',
  );
  // 零槽位(同刻零长):判过长
  ok(
    decideSpeedAction(500, 0, 'native').estimatedOverlong,
    'decide: 零槽位判过长(零漏报)',
  );
  // 空文本:静音行,无动作
  eq(
    decideSpeedAction(0, 1000, 'native').ratio,
    0,
    'decide: 空文本 ratio=0 原速',
  );
  ok(ALIGN_ONESHOT_THRESHOLD === 1.15, 'decide: 一次到位阈值 1.15');
}

// ── recheckAfterSynthesis:复测决策 ─────────────────────────────────────────

{
  // 落槽:补静音
  eq(
    recheckAfterSynthesis(900, 1000, 1, { canResynthesize: true }),
    { type: 'fit', padMs: 100 },
    'recheck: 落槽补静音',
  );
  // 本地超槽红线内:重合成(带 5% 余量)
  const r = recheckAfterSynthesis(1200, 1000, 1.1, { canResynthesize: true });
  ok(
    r.type === 'resynthesize' &&
      Math.abs((r as any).speed - Math.min(1.1 * 1.2 * RESYNTH_MARGIN, 1.5)) <
        1e-9,
    'recheck: 本地重合成 speed=已用×残余×1.05',
  );
  // 已重合成过仍超:不再迭代,转 atempo(保证终止)
  eq(
    recheckAfterSynthesis(1100, 1000, 1.2, {
      canResynthesize: true,
      alreadyResynthesized: true,
    }),
    { type: 'atempo', factor: 1.1 },
    'recheck: 重合成一次后仍超转 atempo',
  );
  // 云端:atempo 残余倍率
  eq(
    recheckAfterSynthesis(1200, 1000, 1.1, { canResynthesize: false }),
    { type: 'atempo', factor: 1.2 },
    'recheck: 云端超槽走 atempo',
  );
  // 综合倍率超红线:过长(零漏报)——1.4(已用)×1.2(残余)=1.68>1.5
  const o = recheckAfterSynthesis(1200, 1000, 1.4, { canResynthesize: true });
  ok(
    o.type === 'overlong' && Math.abs((o as any).requiredFactor - 1.68) < 1e-9,
    'recheck: 综合倍率超红线判过长',
  );
  // 零槽位:过长
  ok(
    recheckAfterSynthesis(500, 0, 1, { canResynthesize: true }).type ===
      'overlong',
    'recheck: 零槽位判过长',
  );
  // 静音行:fit
  eq(
    recheckAfterSynthesis(0, 1000, 1, { canResynthesize: true }),
    { type: 'fit', padMs: 1000 },
    'recheck: 空音频视为落槽',
  );
}

// ── buildAlignmentPlan:cursor 走查 ─────────────────────────────────────────

{
  // 正常两条:锚定原 start,短于槽位补静音
  const cues = [cue(0, 1000, 3000), cue(1, 5000, 7000)];
  const slots = computeSlots(cues, { mediaDurationMs: 10000 });
  const plan = buildAlignmentPlan(
    [
      {
        index: 0,
        startMs: 1000,
        durationMs: 3500,
        action: { type: 'none' },
        overlong: false,
      },
      {
        index: 1,
        startMs: 5000,
        durationMs: 2000,
        action: { type: 'none' },
        overlong: false,
      },
    ],
    slots,
    { overflow: 'truncate' },
  );
  eq(
    plan.items.map((i) => [i.targetStartMs, i.durationMs, i.padMs]),
    [
      [1000, 3500, 500],
      [5000, 2000, 3000],
    ],
    'plan: 正常行锚定原 start,补静音=槽位-时长',
  );
  eq(plan.overlongIndexes, [], 'plan: 无过长清单');
  eq(plan.overlapIndexes, [], 'plan: 无重叠清单');
}

{
  // truncate:超槽截断,时间轴不漂移
  const cues = [cue(0, 0, 2000), cue(1, 2000, 4000)];
  const slots = computeSlots(cues, { mediaDurationMs: 6000 });
  const plan = buildAlignmentPlan(
    [
      {
        index: 0,
        startMs: 0,
        durationMs: 2500,
        action: { type: 'none' },
        overlong: true,
      },
      {
        index: 1,
        startMs: 2000,
        durationMs: 1000,
        action: { type: 'none' },
        overlong: false,
      },
    ],
    slots,
    { overflow: 'truncate' },
  );
  eq(
    plan.items.map((i) => [i.targetStartMs, i.durationMs]),
    [
      [0, 2000],
      [2000, 1000],
    ],
    'plan: truncate 截断到槽位,后条不受影响',
  );
  eq(plan.overlongIndexes, [0], 'plan: 过长行进清单(用户未接受)');
}

{
  // shift:超槽顺延后条,重叠标记
  const cues = [cue(0, 0, 2000), cue(1, 2000, 4000)];
  const slots = computeSlots(cues, { mediaDurationMs: 6000 });
  const plan = buildAlignmentPlan(
    [
      {
        index: 0,
        startMs: 0,
        durationMs: 2500,
        action: { type: 'none' },
        overlong: false,
      },
      {
        index: 1,
        startMs: 2000,
        durationMs: 1000,
        action: { type: 'none' },
        overlong: false,
      },
    ],
    slots,
    { overflow: 'shift' },
  );
  eq(
    plan.items.map((i) => [i.targetStartMs, i.durationMs]),
    [
      [0, 2500],
      [2500, 1000],
    ],
    'plan: shift 模式后条顺延',
  );
  eq(plan.overlapIndexes, [1], 'plan: 被顺延行进重叠清单');
  // 顺延字幕时间轴
  eq(
    shiftedTimeline(plan),
    [
      { index: 0, startMs: 0, endMs: 2500 },
      { index: 1, startMs: 2500, endMs: 3500 },
    ],
    'plan: 顺延字幕时间轴反映实际占用',
  );
}

{
  // 重叠 cue:A 0–5000 与 B 3000–8000,B 按 A 实际结束顺延
  const cues = [cue(0, 0, 5000), cue(1, 3000, 8000)];
  const slots = computeSlots(cues, { mediaDurationMs: 10000 });
  const plan = buildAlignmentPlan(
    [
      {
        index: 0,
        startMs: 0,
        durationMs: 4800,
        action: { type: 'none' },
        overlong: false,
      },
      {
        index: 1,
        startMs: 3000,
        durationMs: 4000,
        action: { type: 'none' },
        overlong: false,
      },
    ],
    slots,
    { overflow: 'truncate' },
  );
  eq(
    plan.items.map((i) => [i.targetStartMs, i.durationMs]),
    [
      [0, 4800],
      [4800, 4000],
    ],
    'plan: 重叠后条顺延到前条实际结束,不撞车',
  );
  eq(
    plan.overlapIndexes,
    [0, 1],
    'plan: 重叠双方都进清单(前条标记+后条被顺延)',
  );
}

{
  // 空输入
  const plan = buildAlignmentPlan([], [], { overflow: 'truncate' });
  eq(
    plan,
    { items: [], overlongIndexes: [], overlapIndexes: [] },
    'plan: 空文件产出空规划',
  );
}

// ── buildAtempoChain(audioPipeline 纯函数部分)──────────────────────────────

{
  eq(buildAtempoChain(1.3), [1.3], 'atempo: 区间内单级');
  eq(buildAtempoChain(3), [2, 1.5], 'atempo: 3x 链式 2.0×1.5');
  eq(buildAtempoChain(5), [2, 2, 1.25], 'atempo: 5x 链式 2×2×1.25');
  eq(buildAtempoChain(0.4), [0.5, 0.8], 'atempo: 慢放 0.4 链式 0.5×0.8');
  eq(buildAtempoChain(1), [1], 'atempo: 1.0 保留单级(显式无变速)');
  let threw = false;
  try {
    buildAtempoChain(0);
  } catch {
    threw = true;
  }
  ok(threw, 'atempo: 非法倍率抛错');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
