/**
 * 声音克隆质检管线纯逻辑单元测试（无 Electron / 无模型 / 无 ffmpeg 依赖）。
 *
 * 覆盖 main/helpers/voiceClone/referenceAudio.ts：
 *  - 帧分析与切片（RMS/峰值/削波聚合）
 *  - 语音段工具（区间裁剪 / 最长静音）
 *  - SNR 估算与语音电平
 *  - 质检报告分级（error/warning/info 分层与 verdict）
 *  - 自动选段（滑窗打分 / 不贪长 / 短素材兜底）
 *  - 静音压缩规划与自动增益
 *
 * 运行：npm run test:voice-clone
 */
import {
  analyzeSampleFrames,
  sliceFrameAnalysis,
  energyEnvelope,
  clipSegmentsToRange,
  longestSilenceMs,
  estimateSnrDb,
  speechRmsDb,
  speechLevelReferenceDb,
  buildQualityReport,
  suggestCloneSegment,
  planSilenceCompression,
  computeGainDb,
  CLONE_MIN_SPEECH_MS,
  CLONE_SNR_WARN_DB,
  CLONE_LOW_VOLUME_DB,
  CLONE_SILENCE_COMPRESS_ABOVE_MS,
  CLONE_SILENCE_KEEP_MS,
  CLONE_EDGE_PAD_MS,
  type SpeechSegmentMs,
} from '../../main/helpers/voiceClone/referenceAudio';
import {
  CLONE_TARGET_RANGES,
  CLONE_CORRECTIVE_SPEED_MIN,
  CLONE_ZH_RATE_MAX_CPS,
  CLONE_ZH_RATE_TARGET_CPS,
  cjkCharCount,
  dominantTextLanguage,
} from '../../types/voiceClone';
import {
  buildVolcCloneHeaders,
  buildVolcCloneTrainBody,
  parseVolcCloneStatus,
  volcResourceIdForVoice as volcCloneResourceRoute,
  isVolcCloneSpeaker,
  volcCloneErrorHint,
} from '../../main/service/tts/volcengineVoiceCloneUtils';
import { volcResourceIdForVoice } from '../../main/service/tts/volcengineTtsUtils';

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

/** 合成测试波形：分段常幅正弦（幅值 0 = 静音）。sampleRate 16k。 */
const SR = 16000;
function tone(
  parts: Array<{ ms: number; amp: number }>,
  freq = 440,
): Float32Array {
  const total = parts.reduce((a, p) => a + p.ms, 0);
  const out = new Float32Array(Math.round((total / 1000) * SR));
  let offset = 0;
  for (const p of parts) {
    const n = Math.round((p.ms / 1000) * SR);
    for (let i = 0; i < n; i += 1) {
      out[offset + i] = p.amp * Math.sin((2 * Math.PI * freq * i) / SR);
    }
    offset += n;
  }
  return out;
}

function seg(startMs: number, endMs: number): SpeechSegmentMs {
  return { startMs, endMs };
}

// ── 帧分析 ──────────────────────────────────────────────────────────────────

{
  // 1s 0.5 幅正弦：RMS ≈ 0.354 → ≈ -9dB；峰值 ≈ 0.5 → ≈ -6dB；无削波。
  const frames = analyzeSampleFrames(tone([{ ms: 1000, amp: 0.5 }]), SR);
  eq(frames.frameDb.length, 50, 'frames: 1s/20ms = 50 帧');
  ok(
    Math.abs(frames.frameDb[10] - -9.03) < 0.5,
    `frames: 0.5 幅 RMS ≈ -9dB (got ${frames.frameDb[10].toFixed(2)})`,
  );
  ok(
    Math.abs(frames.peakDb - -6.02) < 0.3,
    `frames: 0.5 幅峰值 ≈ -6dB (got ${frames.peakDb.toFixed(2)})`,
  );
  eq(frames.clippingRatio, 0, 'frames: 无削波');
}

{
  // 满幅段触发削波统计。
  const frames = analyzeSampleFrames(
    tone([
      { ms: 500, amp: 1.0 },
      { ms: 500, amp: 0.2 },
    ]),
    SR,
  );
  // 满幅正弦仅峰顶附近 |s|≥0.985（约 11% 周期），前半段占比 ≈ 5.5%。
  ok(frames.clippingRatio > 0.02, 'frames: 满幅段计入削波');
  // 切片到后半段（0.2 幅）：削波归零、峰值下降。
  const slice = sliceFrameAnalysis(frames, 500, 1000);
  eq(slice.frameDb.length, 25, 'sliceFrames: 帧数按区间切');
  eq(slice.clippingRatio, 0, 'sliceFrames: 切片后削波按切片重算');
  ok(slice.peakDb < -10, 'sliceFrames: 切片峰值重算');
}

{
  const frames = analyzeSampleFrames(tone([{ ms: 1000, amp: 0.5 }]), SR);
  const env = energyEnvelope(frames, 100);
  eq(env.length, 10, 'envelope: 1s/100ms = 10 格');
  ok(
    env.every((v) => v >= 0 && v <= 1),
    'envelope: 归一化 0..1',
  );
}

// ── 语音段工具 ──────────────────────────────────────────────────────────────

{
  const segs = [seg(1000, 3000), seg(5000, 8000)];
  eq(
    clipSegmentsToRange(segs, 2000, 6000),
    [seg(2000, 3000), seg(5000, 6000)],
    'clip: 跨界段裁剪到区间',
  );
  eq(clipSegmentsToRange(segs, 3200, 4800), [], 'clip: 无交集为空');
  eq(longestSilenceMs(segs, 0, 10000), 2000, 'silence: 段间隙 2000 为最长静音');
  eq(longestSilenceMs([], 0, 4000), 4000, 'silence: 无语音段 = 全区间静音');
  eq(longestSilenceMs([seg(0, 1000)], 0, 5000), 4000, 'silence: 尾部静音计入');
}

// ── SNR 与语音电平 ──────────────────────────────────────────────────────────

{
  // 前 1s 语音（0.5 幅）+ 后 1s 噪声（0.01 幅）→ SNR ≈ 34dB。
  const frames = analyzeSampleFrames(
    tone([
      { ms: 1000, amp: 0.5 },
      { ms: 1000, amp: 0.01 },
    ]),
    SR,
  );
  const snr = estimateSnrDb(frames, [seg(0, 1000)], 0);
  ok(snr > 25, `snr: 干净录音 > 25dB (got ${snr.toFixed(1)})`);
  // 噪声抬高到 0.15 幅 → SNR ≈ 10.5dB（黄牌区）。
  const noisy = analyzeSampleFrames(
    tone([
      { ms: 1000, amp: 0.5 },
      { ms: 1000, amp: 0.15 },
    ]),
    SR,
  );
  const snr2 = estimateSnrDb(noisy, [seg(0, 1000)], 0);
  ok(
    snr2 < CLONE_SNR_WARN_DB,
    `snr: 嘈杂录音 < ${CLONE_SNR_WARN_DB}dB (got ${snr2.toFixed(1)})`,
  );
  // 全程语音（无噪声帧）→ 取上限。
  eq(estimateSnrDb(frames, [seg(0, 2000)], 0), 40, 'snr: 无噪声帧取上限');
}

{
  const frames = analyzeSampleFrames(
    tone([
      { ms: 1000, amp: 0.5 },
      { ms: 1000, amp: 0.001 },
    ]),
    SR,
  );
  const rms = speechRmsDb(frames, [seg(0, 1000)], 0);
  ok(
    Math.abs(rms - -9.03) < 0.5,
    `speechRms: 静音帧不摊薄均值 (got ${rms.toFixed(2)})`,
  );
}

// ── 质检报告分级 ────────────────────────────────────────────────────────────

{
  // 干净 8s 语音（zipvoice 推荐区间内）→ good。
  const frames = analyzeSampleFrames(
    tone([
      { ms: 200, amp: 0.005 },
      { ms: 8000, amp: 0.4 },
      { ms: 200, amp: 0.005 },
    ]),
    SR,
  );
  const report = buildQualityReport({
    rangeStartMs: 0,
    rangeEndMs: 8400,
    segments: [seg(200, 8200)],
    frames,
    target: CLONE_TARGET_RANGES.zipvoice,
  });
  eq(report.verdict, 'good', 'report: 干净达标素材 verdict=good');
  eq(report.issues, [], 'report: 无问题项');
  eq(report.speechMs, 8000, 'report: 有效语音时长');
}

{
  // 无语音 → error no-speech。
  const frames = analyzeSampleFrames(tone([{ ms: 2000, amp: 0.005 }]), SR);
  const report = buildQualityReport({
    rangeStartMs: 0,
    rangeEndMs: 2000,
    segments: [],
    frames,
  });
  eq(report.verdict, 'poor', 'report: 无语音 verdict=poor');
  eq(report.issues[0]?.code, 'no-speech', 'report: no-speech error');
}

{
  // 2s 语音 < 3s 硬下限 → error too-short。
  const frames = analyzeSampleFrames(tone([{ ms: 2000, amp: 0.4 }]), SR);
  const report = buildQualityReport({
    rangeStartMs: 0,
    rangeEndMs: 2000,
    segments: [seg(0, 2000)],
    frames,
  });
  ok(
    report.issues.some((i) => i.code === 'too-short' && i.severity === 'error'),
    `report: <${CLONE_MIN_SPEECH_MS}ms 硬阻止`,
  );
}

{
  // 4s 语音：过 zipvoice 硬线但低于火山推荐下限 → 黄牌 short-for-engine。
  const frames = analyzeSampleFrames(tone([{ ms: 4000, amp: 0.4 }]), SR);
  const volc = buildQualityReport({
    rangeStartMs: 0,
    rangeEndMs: 4000,
    segments: [seg(0, 4000)],
    frames,
    target: CLONE_TARGET_RANGES.volcengine,
  });
  ok(
    volc.issues.some(
      (i) => i.code === 'short-for-engine' && i.severity === 'warning',
    ),
    'report: 低于引擎推荐下限黄牌',
  );
  eq(volc.verdict, 'fair', 'report: 黄牌 verdict=fair');
}

{
  // 低音量：-40dB 语音 → info low-volume（自动增益）不降级 verdict。
  const frames = analyzeSampleFrames(tone([{ ms: 6000, amp: 0.01 }]), SR);
  const report = buildQualityReport({
    rangeStartMs: 0,
    rangeEndMs: 6000,
    segments: [seg(0, 6000)],
    frames,
    target: CLONE_TARGET_RANGES.zipvoice,
  });
  ok(
    report.issues.some((i) => i.code === 'low-volume' && i.severity === 'info'),
    'report: 低音量 info 项',
  );
  ok(report.rmsDb < CLONE_LOW_VOLUME_DB, 'report: rmsDb 反映语音电平');
  eq(report.verdict, 'good', 'report: 纯 info 不降级 verdict');
}

{
  // 长静音 info + 语音占比黄牌。
  const frames = analyzeSampleFrames(
    tone([
      { ms: 3500, amp: 0.4 },
      { ms: 4000, amp: 0.005 },
      { ms: 500, amp: 0.4 },
    ]),
    SR,
  );
  const report = buildQualityReport({
    rangeStartMs: 0,
    rangeEndMs: 8000,
    segments: [seg(0, 3500), seg(7500, 8000)],
    frames,
    target: CLONE_TARGET_RANGES.zipvoice,
  });
  ok(
    report.issues.some((i) => i.code === 'long-silence'),
    'report: 长静音 info',
  );
  ok(
    report.issues.some((i) => i.code === 'low-speech-ratio'),
    'report: 语音占比黄牌',
  );
  eq(report.longestSilenceMs, 4000, 'report: 最长静音测量');
}

// ── 自动选段 ────────────────────────────────────────────────────────────────

{
  eq(
    suggestCloneSegment([], 60000, CLONE_TARGET_RANGES.zipvoice),
    null,
    'suggest: 无语音段返回 null',
  );
}

{
  // 单个 8s 长语音段（zipvoice 推荐 5–10s）：吸收整段后收口。
  const s = suggestCloneSegment(
    [seg(10000, 18000)],
    60000,
    CLONE_TARGET_RANGES.zipvoice,
  )!;
  eq(s.startMs, 10000 - CLONE_EDGE_PAD_MS, 'suggest: 起点留边距');
  eq(s.endMs, 18000 + CLONE_EDGE_PAD_MS, 'suggest: 终点留边距');
}

{
  // 两个候选窗：碎段区（多长静音）vs 连贯区 → 选连贯区。
  const scattered = [seg(0, 1500), seg(4000, 5500), seg(9000, 10000)];
  const continuous = [seg(20000, 27000)];
  const s = suggestCloneSegment(
    [...scattered, ...continuous],
    60000,
    CLONE_TARGET_RANGES.zipvoice,
  )!;
  ok(
    s.startMs >= 19000 && s.endMs <= 28000,
    `suggest: 选中连贯区 (got ${s.startMs}–${s.endMs})`,
  );
}

{
  // 不贪长：60s 连续语音只取推荐上限附近，不吃满硬上限。
  const s = suggestCloneSegment(
    [seg(0, 60000)],
    60000,
    CLONE_TARGET_RANGES.zipvoice,
  )!;
  ok(
    s.endMs - s.startMs <= CLONE_TARGET_RANGES.zipvoice.maxMs,
    `suggest: 长语音收口在上限内 (got ${s.endMs - s.startMs}ms)`,
  );
}

{
  // 短素材兜底：全文件只有 4s 语音（低于推荐下限）仍给出建议。
  const s = suggestCloneSegment(
    [seg(500, 4500)],
    5000,
    CLONE_TARGET_RANGES.zipvoice,
  );
  ok(!!s, 'suggest: 短素材仍有建议');
}

{
  // 火山目标：多段吸收到 25s 推荐量级。
  const segs = [
    seg(0, 8000),
    seg(8600, 16000),
    seg(16500, 24000),
    seg(24500, 40000),
  ];
  const s = suggestCloneSegment(segs, 60000, CLONE_TARGET_RANGES.volcengine)!;
  ok(
    s.endMs - s.startMs >= 20000 &&
      s.endMs - s.startMs <= CLONE_TARGET_RANGES.volcengine.maxMs,
    `suggest: 火山窗口取到推荐量级 (got ${s.endMs - s.startMs}ms)`,
  );
}

{
  // 能量感知：VAD 判语音但电平微弱的区域（气声/远场，2.4h 课录实测踩坑）
  // 不应胜出——纯占比会选更早的微弱段，携 frames 后选响亮段。
  const weakThenLoud = tone([
    { ms: 9000, amp: 0.005 }, // -46dB 微弱「语音」
    { ms: 11000, amp: 0.001 },
    { ms: 9000, amp: 0.4 }, // -9dB 清晰语音
  ]);
  const frames = analyzeSampleFrames(weakThenLoud, SR);
  const segs = [seg(0, 9000), seg(20000, 29000)];
  const target = CLONE_TARGET_RANGES.zipvoice;
  const plain = suggestCloneSegment(segs, 29000, target)!;
  eq(plain.startMs < 9000, true, 'suggest: 纯占比选中更早的微弱段（旧行为）');
  const aware = suggestCloneSegment(segs, 29000, target, frames)!;
  ok(
    aware.startMs >= 19000,
    `suggest: 能量感知选中响亮段 (got ${aware.startMs}–${aware.endMs})`,
  );
}

{
  // speechLevelReferenceDb：90 分位落在响亮段电平附近。
  const mixed = tone([
    { ms: 2000, amp: 0.01 },
    { ms: 8000, amp: 0.4 },
  ]);
  const frames = analyzeSampleFrames(mixed, SR);
  const refDb = speechLevelReferenceDb(frames, [seg(0, 10000)]);
  ok(
    Math.abs(refDb - -9) < 2,
    `suggest: 电平参照 ≈ 响亮段 RMS (got ${refDb.toFixed(1)}dB)`,
  );
}

// ── 静音压缩规划 ────────────────────────────────────────────────────────────

{
  // 无语音段：整段保留（调用方在报告层已拦 no-speech）。
  eq(
    planSilenceCompression([], 3000),
    [{ startMs: 0, endMs: 3000 }],
    'plan: 无语音段整段保留',
  );
}

{
  // 首尾静音收敛 + 内部 2s 静音压缩为 keep。
  const keeps = planSilenceCompression(
    [seg(1000, 4000), seg(6000, 9000)],
    10000,
  );
  eq(keeps.length, 2, 'plan: 长静音断为两个保留区');
  eq(keeps[0].startMs, 1000 - CLONE_EDGE_PAD_MS, 'plan: 头部收敛到边距');
  eq(
    keeps[0].endMs,
    4000 + CLONE_SILENCE_KEEP_MS / 2,
    'plan: 语音尾后留半个 keep',
  );
  eq(
    keeps[1].startMs,
    6000 - CLONE_SILENCE_KEEP_MS / 2,
    'plan: 下段语音前留半个 keep',
  );
  eq(keeps[1].endMs, 9000 + CLONE_EDGE_PAD_MS, 'plan: 尾部收敛到边距');
  // 压缩量：2000ms 静音 → 300ms。
  const kept = keeps.reduce((a, k) => a + (k.endMs - k.startMs), 0);
  ok(
    kept < 10000 - (2000 - CLONE_SILENCE_KEEP_MS) + 1,
    'plan: 总时长按压缩量缩短',
  );
}

{
  // 短间隙（≤ compressAbove）不断开。
  const keeps = planSilenceCompression(
    [seg(500, 2000), seg(2000 + CLONE_SILENCE_COMPRESS_ABOVE_MS - 100, 5000)],
    6000,
  );
  eq(keeps.length, 1, 'plan: 短间隙不断开');
}

{
  // 边界钳制：语音段起点在 0 附近不产生负区间。
  const keeps = planSilenceCompression([seg(50, 3000)], 3000);
  eq(keeps[0].startMs, 0, 'plan: 起点钳到 0');
  eq(keeps[0].endMs, 3000, 'plan: 终点钳到区间末');
}

// ── 自动增益 ────────────────────────────────────────────────────────────────

{
  eq(computeGainDb(-20, -6), 0, 'gain: 电平达标不增益');
  eq(computeGainDb(-38, -26), 18, 'gain: 抬到目标电平（峰值余量足）');
  eq(computeGainDb(-40, -10), 9, 'gain: 峰值保护钳制');
  eq(computeGainDb(-60, -40), 20, 'gain: 最大增益钳制');
  eq(computeGainDb(-29.9, -12), 0, 'gain: 阈值线上不动');
}

// ── worker tts-config 的 zipvoice 分支（纯 JS，直接 require）────────────────

// 编译产物在 node_modules/.cache 下，相对路径失效；npm run 从仓库根执行。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ttsConfig = require(
  require('path').join(
    process.cwd(),
    'extraResources/sherpa/worker/tts-config.js',
  ),
);

{
  const req = {
    modelType: 'zipvoice',
    encoder: '/m/encoder.int8.onnx',
    decoder: '/m/decoder.int8.onnx',
    vocoder: '/m/vocos_24khz.onnx',
    tokens: '/m/tokens.txt',
    dataDir: '/m/espeak-ng-data',
    lexicon: '/m/lexicon.txt',
    numThreads: 4,
  };
  const config = ttsConfig.buildTtsConfig(req);
  eq(
    config.model.zipvoice,
    {
      encoder: '/m/encoder.int8.onnx',
      decoder: '/m/decoder.int8.onnx',
      vocoder: '/m/vocos_24khz.onnx',
      tokens: '/m/tokens.txt',
      dataDir: '/m/espeak-ng-data',
      lexicon: '/m/lexicon.txt',
    },
    'ttsConfig: zipvoice 三工件 + tokens/dataDir/lexicon 映射',
  );
  eq(config.maxNumSentences, 1, 'ttsConfig: 整段一次生成');
  ok(
    !('kokoro' in config.model) && !('vits' in config.model),
    'ttsConfig: zipvoice 不带其它模型槽位',
  );
  const key = ttsConfig.buildTtsCacheKey(req);
  ok(
    key.includes('/m/encoder.int8.onnx') &&
      key.includes('/m/decoder.int8.onnx') &&
      key.includes('/m/vocos_24khz.onnx'),
    'ttsConfig: cacheKey 含 zipvoice 三工件',
  );
  const key2 = ttsConfig.buildTtsCacheKey({
    ...req,
    vocoder: '/m/other-vocoder.onnx',
  });
  ok(key !== key2, 'ttsConfig: 换 vocoder 变更缓存键');
}

{
  let threw = false;
  try {
    ttsConfig.buildTtsConfig({ modelType: 'unknown' });
  } catch {
    threw = true;
  }
  ok(threw, 'ttsConfig: 未知 modelType 抛错');
}

// ── 克隆合成文本切块（内存安全约束）─────────────────────────────────────────

{
  // 中文数字归一化（zipvoice 无 ruleFsts，阿拉伯数字会读成英文）。
  const { normalizeChineseCloneText } = ttsConfig;
  eq(
    normalizeChineseCloneText('今天是2020年6月25日'),
    '今天是二零二零年六月二十五日',
    'nzh: 年份逐位 + 月日按数值',
  );
  eq(
    normalizeChineseCloneText('增长了3.5%'),
    '增长了百分之三点五',
    'nzh: 百分比小数',
  );
  eq(normalizeChineseCloneText('占80%'), '占百分之八十', 'nzh: 百分比整数');
  eq(
    normalizeChineseCloneText('圆周率约等于3.14'),
    '圆周率约等于三点一四',
    'nzh: 小数',
  );
  eq(
    normalizeChineseCloneText('共有1005人参加'),
    '共有一千零五人参加',
    'nzh: 千位补零',
  );
  eq(
    normalizeChineseCloneText('第12章讲了215个例子'),
    '第十二章讲了二百一十五个例子',
    'nzh: 10-19 口语十X + 百位',
  );
  eq(
    normalizeChineseCloneText('电话13800138000'),
    '电话一三八零零一三八零零零',
    'nzh: 超长数字串逐位',
  );
  eq(
    normalizeChineseCloneText('It was released in 2020.'),
    'It was released in 2020.',
    'nzh: 无 CJK 的纯外文行不动',
  );
  eq(
    normalizeChineseCloneText('总量达12万亿'),
    '总量达十二万亿',
    'nzh: 数字+单位词组合',
  );
}

{
  const { splitCloneText, cloneChunkLimit } = ttsConfig;
  eq(splitCloneText(''), [], 'split: 空文本');
  eq(splitCloneText('好的。'), ['好的。'], 'split: 短句原样');
  // 句读切块 + 短块合并。
  eq(
    splitCloneText('第一句话在这里。第二句紧跟其后。好。'),
    ['第一句话在这里。第二句紧跟其后。好。'],
    'split: 上限内句子合并为单块',
  );
  // 超上限(20 CJK)按句读切开。
  const two = splitCloneText(
    '这是相当长的第一个句子占了十六个字。这是相当长的第二个句子也占十六个字。',
  );
  eq(two.length, 2, 'split: 超上限按句读切两块');
  // 无标点长行(字幕常见)硬上限截断。
  const noPunct = splitCloneText(
    '我希望这能与你已经听到的其他事情产生共鸣我会尝试建立一些联系以防你错过',
  );
  ok(noPunct.length >= 2, 'split: 无标点长行被硬切');
  ok(
    noPunct.every((s) => {
      let w = 0;
      for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c >= 0x4e00 && c <= 0x9fff) w += 1;
      }
      return w <= 20;
    }),
    'split: 每块 CJK 不超上限',
  );
  eq(
    noPunct.join(''),
    '我希望这能与你已经听到的其他事情产生共鸣我会尝试建立一些联系以防你错过',
    'split: 切块无损拼回原文',
  );
  // 空格分隔的行按空格断点切。
  const spaced = splitCloneText(
    '我希望这能与你已经听到的其他事情产生共鸣 我会尝试建立一些联系 以防你错过',
  );
  ok(spaced.length >= 2, 'split: 空格行按空格切');
  // 英文按 0.25 权重(80 chars ≈ 20 CJK)。
  const en = splitCloneText(
    'I want to start with what I call the official dogma of all western industrial societies and the official dogma runs like this',
  );
  ok(en.length >= 2, 'split: 长英文切块');
  // 参考时长驱动的上限收敛。
  eq(cloneChunkLimit(8), 20, 'chunkLimit: 常规参考 20');
  eq(cloneChunkLimit(12.5), 10, 'chunkLimit: 超长存量参考减半');
}

// ── 文本主导语言（跨语言克隆补偿的判定）─────────────────────────────────────

{
  eq(dominantTextLanguage('我要和你谈谈这本书'), 'zh', 'lang: 纯中文');
  eq(
    dominantTextLanguage("I'm going to talk about this book."),
    'en',
    'lang: 纯英文',
  );
  eq(
    dominantTextLanguage('这本书叫 Paradox of Choice 选择的悖论'),
    'zh',
    'lang: 中英混排（中文主导）',
  );
  eq(
    dominantTextLanguage('Check the README 里的说明 for details and more'),
    'en',
    'lang: 英文主导夹少量中文仍偏英',
  );
  eq(dominantTextLanguage('123 456!'), 'en', 'lang: 无字母无汉字回落 en');
}

// ── 跨语言压缩矫正（字符速率闭环）───────────────────────────────────────────

{
  eq(cjkCharCount('我要和你谈谈, OK?'), 6, 'cps: CJK 计数忽略标点与拉丁');
  // 实测场景：16 字被压到 1.89s → 8.5 字/秒 > 6.5 阈值 → 矫正到 4.5 字/秒。
  const cps = 16 / 1.89;
  ok(cps > CLONE_ZH_RATE_MAX_CPS, 'cps: 压缩场景超阈值');
  const factor = Math.max(
    CLONE_CORRECTIVE_SPEED_MIN,
    CLONE_ZH_RATE_TARGET_CPS / cps,
  );
  ok(
    Math.abs(16 / ((1.89 / factor) * 1) - CLONE_ZH_RATE_TARGET_CPS) < 0.01,
    'cps: atempo 矫正后速率精确回到目标',
  );
  // 自然速率不触发。
  ok(16 / 3.6 < CLONE_ZH_RATE_MAX_CPS, 'cps: 自然速率(4.4 字/秒)不矫正');
  // 极端压缩：下限钳制。
  eq(
    Math.max(CLONE_CORRECTIVE_SPEED_MIN, CLONE_ZH_RATE_TARGET_CPS / 20),
    CLONE_CORRECTIVE_SPEED_MIN,
    'cps: 矫正系数下限钳制',
  );
}

// ── 火山声音复刻纯工具 ──────────────────────────────────────────────────────

{
  const h = buildVolcCloneHeaders(' 123456 ', ' tok ', 'req-1');
  eq(h['X-Api-App-Key'], '123456', 'volcClone: appId trim');
  eq(h['X-Api-Access-Key'], 'tok', 'volcClone: accessToken trim');
  eq(h['X-Api-Request-Id'], 'req-1', 'volcClone: requestId 透传');
}

{
  const body = buildVolcCloneTrainBody('S_abc', 'QkFTRTY0', 'wav', 'zh');
  eq(body.speaker_id, 'S_abc', 'volcClone: speaker_id');
  eq(
    body.audio,
    { data: 'QkFTRTY0', format: 'wav' },
    'volcClone: audio 形态（真机实测 audios 报 unmapped key）',
  );
  eq(body.language, 0, 'volcClone: zh → 0');
  eq(body.model_types, [4], 'volcClone: ICL 2.0 = model_types [4]');
  ok(!('extra_params' in body), 'volcClone: 开关全关不携带 extra_params');
  const body2 = buildVolcCloneTrainBody('S_abc', 'x', 'wav', 'en', {
    denoise: true,
    mss: true,
  });
  eq(body2.language, 1, 'volcClone: en → 1');
  eq(
    body2.extra_params,
    { enable_audio_denoise: true, voice_clone_enable_mss: true },
    'volcClone: 开关按需携带',
  );
}

{
  eq(
    parseVolcCloneStatus({ status: 2 }).state,
    'ready',
    'volcClone: status 2 ready',
  );
  eq(
    parseVolcCloneStatus({ status: 4 }).state,
    'ready',
    'volcClone: status 4 ready',
  );
  eq(
    parseVolcCloneStatus({ status: 1 }).state,
    'training',
    'volcClone: status 1 training',
  );
  eq(
    parseVolcCloneStatus({ status: 3 }).state,
    'failed',
    'volcClone: status 3 failed',
  );
  eq(
    parseVolcCloneStatus({ status: 0 }).state,
    'failed',
    'volcClone: status 0 notfound=failed',
  );
  // 多形态兼容与回退信号。
  eq(
    parseVolcCloneStatus({}).found,
    false,
    'volcClone: 无 status → found=false（触发 V1 回退）',
  );
  eq(
    parseVolcCloneStatus({ BaseResp: { StatusCode: 0 }, status: 2 }).state,
    'ready',
    'volcClone: V1 形态（BaseResp + 顶层 status）',
  );
  eq(
    parseVolcCloneStatus({ data: { status: 2 } }).state,
    'ready',
    'volcClone: data.status 嵌套形态',
  );
  eq(
    parseVolcCloneStatus({ speaker_status: [{ status: 4 }] }).state,
    'ready',
    'volcClone: speaker_status 列表形态',
  );
  eq(
    parseVolcCloneStatus({ status: 'Success' }).state,
    'ready',
    'volcClone: 字符串态 Success',
  );
  eq(
    parseVolcCloneStatus({ status: 'Training' }).state,
    'training',
    'volcClone: 字符串态 Training',
  );
  eq(
    parseVolcCloneStatus({ status: '2' }).state,
    'ready',
    'volcClone: 数字字符串态',
  );
}

{
  // 合成资源路由（TTS utils 与 clone utils 两份同语义）。
  eq(
    volcResourceIdForVoice('S_abc123', 'seed-tts-2.0'),
    'seed-icl-2.0',
    'route: S_ 音色切 seed-icl-2.0',
  );
  eq(
    volcResourceIdForVoice('zh_female_vv_uranus_bigtts', 'seed-tts-2.0'),
    'seed-tts-2.0',
    'route: 普通音色沿用配置',
  );
  eq(
    volcResourceIdForVoice('S_x', undefined),
    'seed-icl-2.0',
    'route: 配置缺省不影响克隆路由',
  );
  eq(
    volcCloneResourceRoute('S_x', 'seed-tts-1.0'),
    'seed-icl-2.0',
    'route: clone utils 同语义',
  );
  ok(
    isVolcCloneSpeaker('S_abc') && !isVolcCloneSpeaker('zh_male_x'),
    'route: S_ 判定',
  );
}

{
  ok(
    volcCloneErrorHint(401, null, 'unauthorized').includes('APP ID'),
    'cloneHint: 401 指向双凭据',
  );
  ok(
    volcCloneErrorHint(200, 1109, 'speaker not exist').includes('speaker_id'),
    'cloneHint: 槽位不存在',
  );
  ok(
    volcCloneErrorHint(200, 500, 'training count exceed limit').includes(
      '上限',
    ),
    'cloneHint: 次数上限',
  );
  ok(
    volcCloneErrorHint(200, 45001109, 'WERError audio mismatch').includes(
      '质检',
    ),
    'cloneHint: 音频质量拒绝',
  );
  ok(
    !volcCloneErrorHint(
      400,
      45000000,
      'add unmapped key audios to params store: failed to convert',
    ).includes('质检'),
    'cloneHint: 参数错误类 message 含 audio 不误判为质检',
  );
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\nvoice-clone units: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
