/**
 * 配音对齐引擎纯逻辑单元测试（无 Electron / 无模型依赖）。
 *
 * 覆盖 main/helpers/dubbing 的可单测部分：
 *  - alignment: 槽位计算（间隙借用/末条/重叠/零长/空文件）、时长预估与校准、
 *    ratio 四档决策树、复测决策（重合成 vs atempo vs 过长零漏报）、
 *    最终规划 cursor 走查（顺延/截断/补静音）、mix 模式轨道分配、顺延字幕时间轴
 *  - audioPipeline: buildAtempoChain 链分解、writePcmAsWav 包头往返
 *  - service/tts 纯工具: azureUtils（SSML 构造/转义/rate 折算/端点拼接）、
 *    elevenlabsTtsUtils（base 规范化/speed clamp/body 构造）、
 *    volcengineTtsUtils（速率折算/body 构造/流解析/错误分类）
 *
 * 运行：npm run test:dubbing
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
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
import {
  buildAtempoChain,
  writePcmAsWav,
  readWavInfo,
} from '../../main/helpers/dubbing/audioPipeline';
import {
  escapeXml,
  azureLangFromVoice,
  speedToAzureProsodyRate,
  buildAzureSsml,
  buildAzureEndpoint,
  buildAzureVoicesListURL,
  mapAzureVoices,
  normalizeAzureHost,
} from '../../main/service/tts/azureUtils';
import {
  normalizeElevenLabsTtsBaseURL,
  buildElevenLabsTtsURL,
  buildElevenLabsVoicesURL,
  mapElevenLabsVoices,
  clampElevenLabsSpeed,
  buildElevenLabsBody,
} from '../../main/service/tts/elevenlabsTtsUtils';
import {
  buildVolcTtsHeaders,
  buildVolcTtsBody,
  speedToVolcSpeechRate,
  parseVolcTtsStream,
  volcTtsErrorHint,
} from '../../main/service/tts/volcengineTtsUtils';
import {
  ALIGN_ONESHOT_THRESHOLD,
  ALIGN_OVERLONG_THRESHOLD,
  type DubbingSessionMeta,
} from '../../types/dubbing';
import {
  setDubbingSessionsRoot,
  getSessionDir,
  hashSubtitleContent,
  flushSessionMeta,
  readSessionMeta,
  deleteSessionData,
  resolvePersistedCue,
} from '../../main/helpers/dubbing/sessionStore';
import {
  parseTtsVoiceLabels,
  resolveTtsVoiceLabel,
} from '../../types/ttsProvider';

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

// ── buildAlignmentPlan:mix 模式轨道分配 ─────────────────────────────────────

{
  // 两两重叠:A 0–5000 与 B 3000–8000,mix 下各占一轨、锚定原 start
  const cues = [cue(0, 0, 5000), cue(1, 3000, 8000)];
  const slots = computeSlots(cues, { mediaDurationMs: 10000 });
  const finals = [
    {
      index: 0,
      startMs: 0,
      durationMs: 4800,
      action: { type: 'none' as const },
      overlong: false,
    },
    {
      index: 1,
      startMs: 3000,
      durationMs: 4000,
      action: { type: 'none' as const },
      overlong: false,
    },
  ];
  const plan = buildAlignmentPlan(finals, slots, {
    overflow: 'truncate',
    overlapMode: 'mix',
  });
  eq(
    plan.items.map((i) => [i.targetStartMs, i.lane]),
    [
      [0, 0],
      [3000, 1],
    ],
    'mix: 重叠行分轨锚定原 start,互不顺延',
  );
  eq(plan.overlapIndexes, [0], 'mix: 重叠告警仍在(前条 overlapNext)');
  // 同输入 shift 模式:后条顺延、单轨(回归)
  const shiftPlan = buildAlignmentPlan(finals, slots, {
    overflow: 'truncate',
    overlapMode: 'shift',
  });
  eq(
    shiftPlan.items.map((i) => [i.targetStartMs, i.lane]),
    [
      [0, 0],
      [4800, 0],
    ],
    'mix 回归: shift 模式仍按 start 顺延且恒轨 0',
  );
}

{
  // 三行互叠:各占一轨;后续无重叠行回落轨 0
  const cues = [
    cue(0, 0, 6000),
    cue(1, 1000, 7000),
    cue(2, 2000, 8000),
    cue(3, 9000, 10000),
  ];
  const slots = computeSlots(cues, { mediaDurationMs: 12000 });
  const finals = cues.map((c) => ({
    index: c.index,
    startMs: c.startMs,
    durationMs: 800,
    action: { type: 'none' as const },
    overlong: false,
  }));
  const plan = buildAlignmentPlan(finals, slots, {
    overflow: 'truncate',
    overlapMode: 'mix',
  });
  eq(
    plan.items.map((i) => i.lane),
    [0, 1, 2, 0],
    'mix: 三行互叠占三轨,错开后回落轨 0(贪心最小编号)',
  );
  eq(
    plan.items.map((i) => i.targetStartMs),
    [0, 1000, 2000, 9000],
    'mix: 全部锚定原 start',
  );
}

{
  // 无重叠字幕:mix 与 shift 产出等价(含 overflow shift 溢出仍走轨内顺延)
  const cues = [cue(0, 0, 2000), cue(1, 2000, 4000)];
  const slots = computeSlots(cues, { mediaDurationMs: 6000 });
  const finals = [
    {
      index: 0,
      startMs: 0,
      durationMs: 2500, // 溢出槽位(2000)
      action: { type: 'none' as const },
      overlong: false,
    },
    {
      index: 1,
      startMs: 2000,
      durationMs: 1000,
      action: { type: 'none' as const },
      overlong: false,
    },
  ];
  const mixPlan = buildAlignmentPlan(finals, slots, {
    overflow: 'shift',
    overlapMode: 'mix',
  });
  const shiftPlan = buildAlignmentPlan(finals, slots, {
    overflow: 'shift',
    overlapMode: 'shift',
  });
  eq(mixPlan, shiftPlan, 'mix: 无重叠字幕两模式规划完全等价(溢出顺延同轨消解)');
  eq(
    mixPlan.items.map((i) => [i.targetStartMs, i.lane]),
    [
      [0, 0],
      [2500, 0],
    ],
    'mix: 合成溢出不开新轨(轨道分配按原字幕区间)',
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

// ── writePcmAsWav:裸 PCM 包头往返(ElevenLabs 零转码落盘)────────────────────

{
  const tmp = path.join(os.tmpdir(), `smartsub-test-pcm-${Date.now()}.wav`);
  try {
    // 1 秒 24kHz 16-bit 单声道 = 48000 字节
    const pcm = Buffer.alloc(48000);
    const durationMs = writePcmAsWav(pcm, 24000, tmp);
    eq(durationMs, 1000, 'pcmWav: 返回时长按字节折算');
    const info = readWavInfo(tmp);
    eq(
      [info.sampleRate, info.channels, info.bitsPerSample, info.durationMs],
      [24000, 1, 16, 1000],
      'pcmWav: readWavInfo 往返一致',
    );
    // 奇数字节:截齐 16-bit 对齐
    const odd = writePcmAsWav(Buffer.alloc(3), 24000, tmp);
    eq(readWavInfo(tmp).dataBytes, 2, 'pcmWav: 奇数字节截齐对齐');
    ok(odd === 0, 'pcmWav: 不足 1ms 时长取整为 0');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

// ── azureUtils:SSML 构造 / 转义 / rate 折算 / 端点拼接 ──────────────────────

{
  eq(
    escapeXml(`a&b<c>"d'`),
    'a&amp;b&lt;c&gt;&quot;d&apos;',
    'azure: XML 五字符转义',
  );
  eq(
    azureLangFromVoice('zh-CN-XiaoxiaoNeural'),
    'zh-CN',
    'azure: voice 名推导 lang',
  );
  eq(
    azureLangFromVoice('yue-CN-XiaoMinNeural'),
    'yue-CN',
    'azure: 三字母语种前缀',
  );
  eq(azureLangFromVoice('weird'), 'en-US', 'azure: 非常规命名回落 en-US');

  eq(speedToAzureProsodyRate(1), null, 'azure: speed=1 省略 prosody');
  eq(speedToAzureProsodyRate(undefined), null, 'azure: 缺省 speed 省略');
  eq(speedToAzureProsodyRate(1.004), null, 'azure: 折算 0% 省略');
  eq(speedToAzureProsodyRate(1.3), '+30%', 'azure: 加速折算正百分比');
  eq(speedToAzureProsodyRate(0.8), '-20%', 'azure: 减速折算负百分比');
  eq(speedToAzureProsodyRate(3), '+100%', 'azure: clamp 上界 2.0');
  eq(speedToAzureProsodyRate(0.2), '-50%', 'azure: clamp 下界 0.5');

  const ssml = buildAzureSsml('Hi & bye', 'en-US-AriaNeural', 1.2);
  ok(
    ssml.includes('<prosody rate="+20%">Hi &amp; bye</prosody>') &&
      ssml.includes('xml:lang="en-US"') &&
      ssml.includes('<voice name="en-US-AriaNeural">'),
    'azure: SSML 含转义文本与 prosody 包裹',
  );
  ok(
    !buildAzureSsml('你好', 'zh-CN-XiaoxiaoNeural', 1).includes('<prosody'),
    'azure: 原速 SSML 无 prosody 元素(省计费字符)',
  );

  eq(
    buildAzureEndpoint('eastasia'),
    'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1',
    'azure: region 拼接默认端点',
  );
  eq(
    buildAzureEndpoint('eastasia', 'https://chinaeast2.tts.speech.azure.cn'),
    'https://chinaeast2.tts.speech.azure.cn/cognitiveservices/v1',
    'azure: endpoint 覆盖并补全路径',
  );
  eq(
    buildAzureEndpoint(undefined, 'https://x.azure.cn/cognitiveservices/v1/'),
    'https://x.azure.cn/cognitiveservices/v1',
    'azure: endpoint 已含路径不重复追加',
  );
  // 门户「终结点」域名（认知服务通用域）自动改写到 TTS 域名
  eq(
    normalizeAzureHost('eastus.api.cognitive.microsoft.com'),
    'eastus.tts.speech.microsoft.com',
    'azure: 门户终结点域名改写(国际云)',
  );
  eq(
    normalizeAzureHost('chinaeast2.api.cognitive.azure.cn'),
    'chinaeast2.tts.speech.azure.cn',
    'azure: 门户终结点域名改写(21V 主权云)',
  );
  eq(
    normalizeAzureHost('eastus.tts.speech.microsoft.com'),
    'eastus.tts.speech.microsoft.com',
    'azure: TTS 域名原样保留',
  );
  eq(
    buildAzureEndpoint(
      undefined,
      'https://eastus.api.cognitive.microsoft.com/',
    ),
    'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1',
    'azure: 照抄门户终结点也能拼出正确合成端点',
  );
  let threw = false;
  try {
    buildAzureEndpoint(undefined, undefined);
  } catch {
    threw = true;
  }
  ok(threw, 'azure: 无 region 且无 endpoint 抛错');

  // voices/list 端点与响应映射
  eq(
    buildAzureVoicesListURL('eastus'),
    'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list',
    'azure: voices/list 端点与合成同源',
  );
  eq(
    mapAzureVoices([
      {
        ShortName: 'zh-CN-XiaoxiaoNeural',
        LocalName: '晓晓',
        Locale: 'zh-CN',
      },
      { ShortName: 'en-US-GuyNeural', DisplayName: 'Guy' },
      { LocalName: 'NoId' },
    ]),
    [
      { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (zh-CN)' },
      { id: 'en-US-GuyNeural', name: 'Guy' },
    ],
    'azure: voices/list 映射(LocalName+locale、DisplayName 回落、缺 id 跳过)',
  );
  eq(mapAzureVoices({}), [], 'azure: 非数组响应返回空');
}

// ── elevenlabsTtsUtils:base 规范化 / speed clamp / body 构造 ────────────────

{
  eq(
    normalizeElevenLabsTtsBaseURL(undefined),
    'https://api.elevenlabs.io/v1',
    'eleven: 空 base 回落官方端点',
  );
  eq(
    normalizeElevenLabsTtsBaseURL('https://proxy.example.com/v1/'),
    'https://proxy.example.com/v1',
    'eleven: 去尾斜杠',
  );
  eq(
    normalizeElevenLabsTtsBaseURL(
      'https://proxy.example.com/v1/text-to-speech/abc',
    ),
    'https://proxy.example.com/v1',
    'eleven: 去误粘的 text-to-speech 后缀',
  );
  eq(
    buildElevenLabsTtsURL('https://api.elevenlabs.io/v1', 'voice id'),
    'https://api.elevenlabs.io/v1/text-to-speech/voice%20id?output_format=pcm_24000',
    'eleven: 端点拼接 + voiceId 编码 + pcm_24000',
  );

  eq(clampElevenLabsSpeed(1.4), 1.2, 'eleven: speed clamp 上界 1.2');
  eq(clampElevenLabsSpeed(0.5), 0.7, 'eleven: speed clamp 下界 0.7');
  eq(clampElevenLabsSpeed(undefined), 1, 'eleven: 无效 speed 回落 1');

  eq(
    buildElevenLabsBody('hi', 'eleven_multilingual_v2', 1),
    { text: 'hi', model_id: 'eleven_multilingual_v2' },
    'eleven: 原速省略 voice_settings',
  );
  eq(
    buildElevenLabsBody('hi', 'eleven_multilingual_v2', 1.4),
    {
      text: 'hi',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { speed: 1.2 },
    },
    'eleven: 超界 speed clamp 进 voice_settings',
  );

  // 音色清单拉取与名称映射
  eq(
    buildElevenLabsVoicesURL('https://api.elevenlabs.io/v1'),
    'https://api.elevenlabs.io/v1/voices',
    'eleven: voices 端点拼接',
  );
  eq(
    mapElevenLabsVoices({
      voices: [
        { voice_id: 'a1', name: 'Sarah' },
        { voice_id: 'b2', name: '' },
        { voice_id: '', name: 'Ghost' },
        'garbage',
      ],
    }),
    [
      { id: 'a1', name: 'Sarah' },
      { id: 'b2', name: 'b2' },
    ],
    'eleven: voices 响应宽容解析(空名回落 id、坏条目跳过)',
  );
  eq(mapElevenLabsVoices({}), [], 'eleven: 无 voices 字段返回空');

  const labeled = {
    type: 'elevenlabs',
    voiceLabels: '{"a1":"Sarah","bad":""}',
  };
  eq(
    parseTtsVoiceLabels(labeled),
    { a1: 'Sarah' },
    'labels: JSON 字符串解析且剔除空值',
  );
  eq(parseTtsVoiceLabels({ voiceLabels: '{oops' }), {}, 'labels: 坏 JSON 回空');
  eq(resolveTtsVoiceLabel(labeled, 'a1'), 'Sarah', 'labels: 实例映射优先');
  eq(
    resolveTtsVoiceLabel(labeled, 'EXAVITQu4vr4xnSDxMaL'),
    'Sarah',
    'labels: 未拉取时回落内置 premade 映射',
  );
  eq(
    resolveTtsVoiceLabel(labeled, 'unknown-id'),
    'unknown-id',
    'labels: 无映射原样展示 id',
  );
  eq(
    resolveTtsVoiceLabel(
      { type: 'volcengine' },
      'zh_female_shuangkuaisisi_uranus_bigtts',
    ),
    '爽快思思 2.0',
    'labels: volcengine 内置中文名映射',
  );
}

// ── volcengineTtsUtils:速率折算 / body 构造 / 流解析 / 错误分类 ─────────────

{
  // speech_rate 线性折算：(speed - 1) × 100，clamp [-50, 100]，≈1/无效 → null
  eq(speedToVolcSpeechRate(0.5), -50, 'volc: speed 0.5 → -50');
  eq(speedToVolcSpeechRate(1), null, 'volc: 原速省略字段');
  eq(speedToVolcSpeechRate(1.3), 30, 'volc: speed 1.3 → 30');
  eq(speedToVolcSpeechRate(2), 100, 'volc: speed 2.0 → 100');
  eq(speedToVolcSpeechRate(2.5), 100, 'volc: 超上界 clamp 100');
  eq(speedToVolcSpeechRate(0.3), -50, 'volc: 超下界 clamp -50');
  eq(speedToVolcSpeechRate(undefined), null, 'volc: 无效 speed → null');
  eq(speedToVolcSpeechRate(1.004), null, 'volc: 折算后 ≈0 省略字段');

  eq(
    buildVolcTtsBody('你好', 'zh_female_xiaohe_uranus_bigtts', 1),
    {
      user: { uid: 'video-subtitle-master' },
      req_params: {
        text: '你好',
        speaker: 'zh_female_xiaohe_uranus_bigtts',
        audio_params: { format: 'pcm', sample_rate: 24000 },
      },
    },
    'volc: body 原速省略 speech_rate、固定 pcm 24000',
  );
  eq(
    (
      buildVolcTtsBody('你好', 'v', 1.3) as {
        req_params: { audio_params: Record<string, unknown> };
      }
    ).req_params.audio_params,
    { format: 'pcm', sample_rate: 24000, speech_rate: 30 },
    'volc: body 带 speech_rate',
  );

  const headers = buildVolcTtsHeaders(' key ', undefined, 'req-1');
  eq(headers['X-Api-Key'], 'key', 'volc: header key trim');
  eq(
    headers['X-Api-Resource-Id'],
    'seed-tts-2.0',
    'volc: resourceId 缺省回落 seed-tts-2.0',
  );
  eq(headers['X-Api-Request-Id'], 'req-1', 'volc: header 请求 id');

  // 流解析：分片按行分隔（官方 demo 语义）
  const pcmA = Buffer.from([1, 2, 3, 4]).toString('base64');
  const pcmB = Buffer.from([5, 6]).toString('base64');
  const okStream = [
    `{"code":0,"message":"","data":"${pcmA}"}`,
    '',
    `{"code":0,"message":"","data":"${pcmB}"}`,
    '{"code":20000000,"message":"ok","data":null,"usage":{"text_words":2}}',
  ].join('\n');
  const parsedOk = parseVolcTtsStream(okStream);
  eq(
    Array.from(parsedOk.pcm),
    [1, 2, 3, 4, 5, 6],
    'volc: 多分片 base64 按序拼 PCM(容空行)',
  );
  eq(parsedOk.endCode, 20000000, 'volc: 终止分片 code 提取');
  eq(parsedOk.errorCode, null, 'volc: 成功流无错误码');

  // 无换行直拼形态（brace 扫描兜底）
  const glued = parseVolcTtsStream(
    `{"code":0,"data":"${pcmA}"}{"code":20000000,"message":"ok","data":null}`,
  );
  eq(Array.from(glued.pcm), [1, 2, 3, 4], 'volc: 无换行直拼分片可解析');
  eq(glued.endCode, 20000000, 'volc: 直拼形态终止码提取');

  const errStream = [
    `{"code":0,"message":"","data":"${pcmA}"}`,
    '{"code":55000000,"message":"resource ID is mismatched with speaker related resource","data":null}',
    `{"code":0,"message":"","data":"${pcmB}"}`,
  ].join('\n');
  const parsedErr = parseVolcTtsStream(errStream);
  eq(parsedErr.errorCode, 55000000, 'volc: 错误分片 code 提取并停止消费');
  eq(Array.from(parsedErr.pcm), [1, 2, 3, 4], 'volc: 错误后分片不再消费');
  ok(/mismatched/.test(parsedErr.message), 'volc: 错误 message 提取');

  eq(
    parseVolcTtsStream('garbage not json\n{"oops').pcm.length,
    0,
    'volc: 非 JSON 内容容错为空结果',
  );
  // 实测（2026-07）：HTTP 401 的错误 body 是 header 包裹形态
  const headerErr = parseVolcTtsStream(
    '{"header":{"reqid":"1b2a2d10","code":45000010,"message":"Invalid X-Api-Key"}}',
  );
  eq(headerErr.errorCode, 45000010, 'volc: header.code 错误形态可提取');
  eq(headerErr.message, 'Invalid X-Api-Key', 'volc: header.message 提取');
  // message 字符串内的花括号不干扰 brace 扫描
  eq(
    parseVolcTtsStream('{"code":20000000,"message":"a{b}c\\"d","data":null}')
      .endCode,
    20000000,
    'volc: 字符串内花括号/转义不干扰分片提取',
  );

  // 错误分类四类定向 + 未知回落
  ok(
    /豆包语音|方舟/.test(volcTtsErrorHint(401, null, 'Invalid X-Api-Key')),
    'volc: 401 指向 API Key 来源',
  );
  ok(
    /并发|配额/.test(
      volcTtsErrorHint(200, 45000000, 'quota exceeded for types: concurrency'),
    ),
    'volc: 并发限流引导(quota 关键词优先于 45000000)',
  );
  ok(
    /音色/.test(
      volcTtsErrorHint(
        200,
        45000000,
        'speaker permission denied: get resource id: access denied',
      ),
    ),
    'volc: 45000000 speaker 指向音色',
  );
  ok(
    /seed-tts-2\.0/.test(
      volcTtsErrorHint(
        200,
        55000000,
        'resource ID is mismatched with speaker related resource',
      ),
    ),
    'volc: 55000000 mismatch 指向资源版本对应关系',
  );
  ok(
    /拆分/.test(volcTtsErrorHint(200, 40402003, 'exceed max limit')),
    'volc: 40402003 指向文本超长',
  );
  ok(
    /HTTP 500.*code 55000001/.test(volcTtsErrorHint(500, 55000001, 'boom')),
    'volc: 未知错误透出 HTTP 状态与 code',
  );
}

// ── sessionStore：会话持久化（元数据往返 / hash 校验 / 产物缺失降级 / 删除）──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-session-test-'));
  setDubbingSessionsRoot(root);

  // hash 确定性与内容敏感
  eq(
    hashSubtitleContent('hello'),
    hashSubtitleContent('hello'),
    'session: 同内容 hash 一致',
  );
  ok(
    hashSubtitleContent('hello') !== hashSubtitleContent('hello!'),
    'session: 内容变化 hash 不同',
  );

  const sessionId = 'test-session-1';
  const dir = getSessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // 行级 wav：0 号存在、1 号缺失
  fs.writeFileSync(path.join(dir, 'cue-0.wav'), Buffer.alloc(64));

  const meta: DubbingSessionMeta = {
    version: 1,
    sessionId,
    subtitlePath: '/tmp/a.srt',
    subtitleHash: hashSubtitleContent('1\n00:00:00,000 --> 00:00:01,000\nhi\n'),
    videoPath: undefined,
    mediaDurationMs: 60000,
    updatedAt: Date.now(),
    cues: [
      {
        index: 0,
        startMs: 0,
        endMs: 1000,
        text: 'hi',
        status: 'done',
        overlap: false,
        finalMs: 900,
        appliedSpeed: 1,
        wavFile: 'cue-0.wav',
        action: { type: 'none' },
      },
      {
        index: 1,
        startMs: 1000,
        endMs: 2000,
        text: 'yo',
        voiceId: 'voice-x',
        status: 'done',
        overlap: false,
        finalMs: 800,
        appliedSpeed: 1.1,
        wavFile: 'cue-1.wav',
        action: { type: 'preSpeed', speed: 1.1 },
      },
      {
        index: 2,
        startMs: 2000,
        endMs: 3000,
        text: 'err',
        status: 'failed',
        overlap: false,
        error: 'boom',
        action: { type: 'none' },
      },
    ],
  };

  // 元数据往返
  flushSessionMeta(meta);
  const readBack = readSessionMeta(sessionId);
  ok(readBack !== null, 'session: 元数据可读回');
  eq(readBack?.cues.length, 3, 'session: 行数往返一致');
  eq(readBack?.subtitleHash, meta.subtitleHash, 'session: hash 往返一致');
  eq(readBack?.cues[1].voiceId, 'voice-x', 'session: 行级 voice 覆盖往返');

  // 产物解析：存在 → 绝对路径；缺失 → 降级待合成（保留文本与 voice）
  const resolved0 = resolvePersistedCue(sessionId, readBack!.cues[0]);
  eq(
    resolved0.wavPath,
    path.join(dir, 'cue-0.wav'),
    'session: 产物存在解析为绝对路径',
  );
  eq(resolved0.status, 'done', 'session: 产物存在保持完成态');
  const resolved1 = resolvePersistedCue(sessionId, readBack!.cues[1]);
  eq(resolved1.status, 'pending', 'session: 产物缺失降级待合成');
  eq(resolved1.wavPath, undefined, 'session: 缺失行清空产物路径');
  eq(resolved1.voiceId, 'voice-x', 'session: 降级保留行级 voice');
  const resolved2 = resolvePersistedCue(sessionId, readBack!.cues[2]);
  eq(resolved2.status, 'failed', 'session: 失败行保持失败态（可重试）');

  // 损坏元数据 → null
  fs.writeFileSync(path.join(dir, 'session.json'), '{broken');
  eq(readSessionMeta(sessionId), null, 'session: 损坏元数据返回 null');

  // 删除联动
  deleteSessionData(sessionId);
  ok(!fs.existsSync(dir), 'session: 删除清理会话目录');

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
