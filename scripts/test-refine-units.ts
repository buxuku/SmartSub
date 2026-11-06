/// <reference path="./test-globals.d.ts" />
/**
 * AI 字幕精修纯逻辑单元测试（openspec: add-ai-subtitle-refine，无 Electron / 无网络）。
 *
 * 覆盖 subtitleRefine 纯函数层：
 *  - protocol: 窗口文本拼装 / `<br>` 输出解析
 *  - types: 限长派生 / 语言判定
 *  - validator: 等值 + 差异定位 + 逐段限长 + 反馈文案
 *  - alignment: 精确 offset 对齐（词级）/ 近似比例插值对齐（cue 级）
 *  - windowing: 300–500 词分窗 / 章节级停顿提前切
 *  - guards: 超宽重切（关闭 gap 切分）/ 短碎片合并 / 最短显示时长
 *
 * 运行：npm run test:refine
 * 真实 LLM 请求属 segmentationRunner（主进程编排层），不在本脚本覆盖范围。
 */
import { diffArrays } from 'diff';
import {
  buildWindowText,
  buildCueWindowText,
  parseBrSegments,
} from '../main/helpers/subtitleRefine/protocol';
import {
  limitsFromCueOptions,
  normalizeForCompare,
  isMainlyCjk,
  RefineWord,
} from '../main/helpers/subtitleRefine/types';
import {
  anchorSegmentsToOriginal,
  describeDifferences,
  REPORT_MIN_SIMILARITY,
} from '../main/helpers/subtitleRefine/anchoring';
import {
  compareValidations,
  formatSimilarity,
  validateSegmentation,
} from '../main/helpers/subtitleRefine/validator';
import {
  alignSegmentsToWords,
  alignSegmentsToCues,
} from '../main/helpers/subtitleRefine/alignment';
import {
  splitWordsIntoWindows,
  splitCuesIntoWindows,
} from '../main/helpers/subtitleRefine/windowing';
import { applySegmentationGuards } from '../main/helpers/subtitleRefine/guards';
import {
  collectSuspectWords,
  filterSuspectWordsForBatch,
} from '../main/helpers/subtitleRefine/wordSources';
import type { TokenTriple } from '../main/helpers/subtitleSegmentation';

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
  eq(!!cond, true, name);
}

/** 造 CJK 词流：每字一词（贴近 whisper CJK token 形态），gaps[i] = 第 i 字前的停顿 ms。 */
function cjkWords(
  text: string,
  opts?: { perCharMs?: number; gaps?: Record<number, number> },
): RefineWord[] {
  const per = opts?.perCharMs ?? 220;
  const words: RefineWord[] = [];
  let t = 0;
  Array.from(text).forEach((ch, i) => {
    t += opts?.gaps?.[i] ?? 0;
    words.push({ text: ch, start: t, end: t + per });
    t += per;
  });
  return words;
}

/** 造英文词流：每词带前导空格（贴近 whisper token 形态）。 */
function enWords(
  sentence: string,
  opts?: { perWordMs?: number; gaps?: Record<number, number> },
): RefineWord[] {
  const per = opts?.perWordMs ?? 300;
  const words: RefineWord[] = [];
  let t = 0;
  sentence.split(' ').forEach((w, i) => {
    t += opts?.gaps?.[i] ?? 0;
    words.push({ text: (i === 0 ? '' : ' ') + w, start: t, end: t + per });
    t += per;
  });
  return words;
}

// ---------------- protocol ----------------

eq(
  buildWindowText(enWords('so the first thing')),
  'so the first thing',
  'protocol: 英文词拼接折叠前导空格',
);
eq(buildWindowText(cjkWords('大家好')), '大家好', 'protocol: CJK 词拼接');
eq(
  buildCueWindowText([
    ['00:00:00,000', '00:00:01,000', 'hello world'],
    ['00:00:01,000', '00:00:02,000', 'again'],
  ]),
  'hello world again',
  'protocol: cue 文本以空格相接',
);
eq(
  parseBrSegments('大家好<br>今天我们聊聊'),
  ['大家好', '今天我们聊聊'],
  'protocol: 基础 <br> 切分',
);
eq(
  parseBrSegments('```\n大家好<br/>今天\n```'),
  ['大家好', '今天'],
  'protocol: 剥代码围栏 + <br/> 变体',
);
eq(
  parseBrSegments('abc\ndef<BR>ghi'),
  ['abcdef', 'ghi'],
  'protocol: 换行删除（不作断点）+ 大写变体',
);
eq(parseBrSegments('<br>a<br><br>b<br>'), ['a', 'b'], 'protocol: 去空段');

// ---------------- types / limits ----------------

eq(
  limitsFromCueOptions(undefined),
  {
    maxWidth: 40,
    cjkCharLimit: 18,
    latinWordLimit: 8,
    lengthCheckEnabled: true,
  },
  'limits: 默认 40 → CJK18 / 拉丁8',
);
eq(
  limitsFromCueOptions({ maxWidth: 20 }),
  {
    maxWidth: 20,
    cjkCharLimit: 8,
    latinWordLimit: 4,
    lengthCheckEnabled: true,
  },
  'limits: 窄宽度夹到下限',
);
const unlimitedLimits = limitsFromCueOptions({
  maxWidth: Number.POSITIVE_INFINITY,
});
eq(unlimitedLimits.lengthCheckEnabled, false, 'limits: 不限制长度关闭校验');
eq(unlimitedLimits.cjkCharLimit, 18, 'limits: 不限制长度仍给提示词默认限长');

ok(isMainlyCjk('我们用 Kubernetes 做扩缩容'), 'lang: 中英夹杂判 CJK');
ok(!isMainlyCjk('so the first thing we did'), 'lang: 纯英文判拉丁');
eq(normalizeForCompare(' a b\nc '), 'abc', 'norm: 去全部空白');

// ---------------- validator ----------------

const limits = limitsFromCueOptions(undefined);
const vOk = validateSegmentation(
  '大家好今天我们聊聊',
  ['大家好', '今天我们聊聊'],
  limits,
);
eq(vOk.ok, true, 'validator: 合法输出通过');
eq(vOk.feedback, '', 'validator: 通过时无反馈');

const vModified = validateSegmentation(
  '大家好今天我们聊聊',
  ['大家好', '今天我们聊聊天'],
  limits,
);
eq(vModified.contentOk, false, 'validator: 插字判 content 不通过');
ok(vModified.feedback.includes('inserted'), 'validator: 反馈定位插入');

const vDeleted = validateSegmentation(
  '它使用反向传播算法',
  ['它使用反向传算法'],
  limits,
);
eq(vDeleted.contentOk, false, 'validator: 删字判 content 不通过');
ok(vDeleted.feedback.includes('deleted'), 'validator: 反馈定位删除');

const longCjk = '一二三四五六七八九十一二三四五六七八九十';
const vLength = validateSegmentation(longCjk, [longCjk], limits);
eq(vLength.contentOk, true, 'validator: 超长但内容一致');
eq(vLength.ok, false, 'validator: 超长判不通过');
eq(vLength.lengthViolations[0].unit, 'chars', 'validator: CJK 按字数');
ok(
  vLength.feedback.includes('Length violations'),
  'validator: 超长反馈提示再切分',
);
eq(
  validateSegmentation(longCjk, [longCjk], unlimitedLimits).ok,
  true,
  'validator: 不限制长度时超长放行',
);

const enSentence = 'so the first thing we did was add a cache layer';
const vEn = validateSegmentation(enSentence, [enSentence], limits);
eq(vEn.lengthViolations[0].unit, 'words', 'validator: 拉丁按词数');
eq(vEn.lengthViolations[0].count, 11, 'validator: 拉丁词数统计');

eq(
  validateSegmentation('abc', [], limits).ok,
  false,
  'validator: 空结果不通过',
);

// ---------------- validator · compareValidations（#507：保留最好的一次） ----------------

const halfLong = '一二三四五六七八九十';
const cmpOneLong = validateSegmentation(longCjk, [longCjk], limits); // 内容一致，1 个超长段
const cmpTwoLong = validateSegmentation(
  longCjk + longCjk,
  [longCjk, longCjk],
  limits,
); // 内容一致，2 个超长段（各超 2）
const cmpOneHuge = validateSegmentation(
  longCjk + longCjk,
  [longCjk + longCjk],
  limits,
); // 内容一致，1 个超长段（超 22）
const cmpValid = validateSegmentation(longCjk, [halfLong, halfLong], limits); // 完全合规
const cmpBroken = validateSegmentation(
  '大家好今天我们聊聊',
  ['大家好'],
  limits,
); // 截断，内容不可用
const cmpOvershoot4 = validateSegmentation(
  longCjk + '一二',
  [longCjk + '一二'],
  limits,
);
const cmpOvershoot3 = validateSegmentation(
  longCjk + '一二',
  [longCjk + '一', '二'],
  limits,
);

ok(
  compareValidations(cmpOneLong, vModified) > 0 &&
    compareValidations(vModified, cmpOneLong) < 0,
  'compare: 内容可用（即便超长）优于内容被改写',
);
ok(
  compareValidations(cmpValid, cmpOneLong) > 0,
  'compare: 完全合规优于带超长段',
);
ok(
  compareValidations(cmpOneHuge, cmpTwoLong) > 0,
  'compare: 超长段更少者优先（即使单段超得更多）',
);
ok(
  compareValidations(cmpOvershoot3, cmpOvershoot4) > 0,
  'compare: 超长段数相同时超出量更小者优先',
);
eq(compareValidations(cmpOneLong, cmpOneLong), 0, 'compare: 同一结果打平');
ok(
  compareValidations(vModified, cmpBroken) > 0,
  'compare: 都不可用时相似度更高者优先',
);

// ---------------- anchoring · 容差内的偏差按模型断点重锚定到原文（#507） ----------------

const driftOriginal =
  'So, the first thing we did was add a cache layer. In front of the database, and that alone cut the response time by almost forty percent. Then we moved on to the next problem, which was the slow image resizing job that blocked every upload.';
// 模型的断点（无标点、全小写）：断在语义处。
const driftBreaks = [
  'so the first thing we did',
  'was add a cache layer',
  'in front of the database',
  'and that alone cut the response time',
  'by almost forty percent',
  'then we moved on to the next problem',
  'which was the slow image resizing job',
  'that blocked every upload',
];
// 期望：原文的标点与大小写原样保留，收尾标点归属它收尾的那一段。
const driftExpected = [
  'So, the first thing we did',
  'was add a cache layer.',
  'In front of the database,',
  'and that alone cut the response time',
  'by almost forty percent.',
  'Then we moved on to the next problem,',
  'which was the slow image resizing job',
  'that blocked every upload.',
];

const anchoredPunct = anchorSegmentsToOriginal(driftOriginal, driftBreaks);
eq(
  anchoredPunct?.segments,
  driftExpected,
  'anchor: 标点/大小写差异——断点落到原文，标点留在原文位置',
);
eq(anchoredPunct?.similarity, 1, 'anchor: 骨架一致时相似度 1');
eq(anchoredPunct?.editedChars, 0, 'anchor: 骨架一致时无改动字符');

// 个别字母被改（拼写“纠正”/笔误）：仍按原文切分，原文文字不受影响。
const typoBreaks = driftBreaks.map((segment) =>
  segment.replace('forty', 'fourty').replace('next', 'nxt'),
);
const anchoredTypo = anchorSegmentsToOriginal(driftOriginal, typoBreaks);
eq(anchoredTypo?.segments, driftExpected, 'anchor: 少量改字不影响断点位置');
eq(anchoredTypo?.editedChars, 2, 'anchor: 统计改动字符数（插 r、删 e）');
ok(
  (anchoredTypo?.similarity ?? 0) > 0.99 && (anchoredTypo?.similarity ?? 1) < 1,
  'anchor: 少量改字的相似度略低于 1',
);

// 删词 + 换词（口头语被清理、同义替换）仍在容差内。
const editedBreaks = driftBreaks.map((segment) =>
  segment.replace('alone ', '').replace('job', 'task'),
);
eq(
  anchorSegmentsToOriginal(driftOriginal, editedBreaks)?.segments,
  driftExpected,
  'anchor: 删词与换词仍在容差内',
);

// 超出容差：整句被删 / 完全无关 / 空输出 → 不重锚定（走原有的拒绝与反馈）。
eq(
  anchorSegmentsToOriginal(driftOriginal, driftBreaks.slice(0, 3)),
  null,
  'anchor: 丢掉大半文本被拒绝',
);
eq(
  anchorSegmentsToOriginal(driftOriginal, [
    'Sorry, I am unable to help with that request.',
  ]),
  null,
  'anchor: 完全无关的文本被拒绝',
);
eq(anchorSegmentsToOriginal(driftOriginal, []), null, 'anchor: 空输出被拒绝');
eq(anchorSegmentsToOriginal('', ['abc']), null, 'anchor: 空原文被拒绝');
// 容差随文本规模缩放：短文本的一处改动就超限，与既有「一字之差即拒」的断言一致。
eq(
  anchorSegmentsToOriginal('大家好今天我们聊聊', ['大家好', '今天我们聊聊天']),
  null,
  'anchor: 短文本的一处改动不放行',
);

// 标点归属：收尾标点归左；起始括号 / 引号 / 货币符号归右。
const quoteOriginal =
  'He said, "Hello there." Then (quietly) left. It costs $5.';
eq(
  anchorSegmentsToOriginal(quoteOriginal, [
    'he said',
    'hello there',
    'then quietly',
    'left',
    'it costs',
    '5',
  ])?.segments,
  ['He said,', '"Hello there."', 'Then (quietly)', 'left.', 'It costs', '$5.'],
  'anchor: 收尾标点归左，起始引号/括号/货币符号归右',
);

// 只有标点的段不产生断点。
eq(
  anchorSegmentsToOriginal('Hello... world again', [
    'hello',
    '...',
    'world again',
  ])?.segments,
  ['Hello...', 'world again'],
  'anchor: 纯标点段并入前一段，不产生空段',
);

// 全角/半角、变音符的组合与分解形式视为同一字符。
eq(
  anchorSegmentsToOriginal('Ｈｅｌｌｏ Wörld again', ['hello', 'wörld again'])
    ?.segments,
  ['Ｈｅｌｌｏ', 'Wörld again'],
  'anchor: 全角字母与预组合/分解的变音符等价',
);

// 辅助平面汉字（代理对）不会被从中间切开。
eq(
  anchorSegmentsToOriginal('𠀀𠀁，𠀂𠀃', ['𠀀𠀁', '𠀂𠀃'])?.segments,
  ['𠀀𠀁，', '𠀂𠀃'],
  'anchor: 代理对不被切开',
);

// 校验器集成：严格等值路径不变；容差内偏差放行并把对齐用的分段换成原文切片。
const exactSegments = ['so the first thing we did', 'was add a cache layer'];
const vExact = validateSegmentation(
  'so the first thing we did was add a cache layer',
  exactSegments,
  limits,
);
eq(vExact.ok, true, 'validator: 严格等值照旧通过');
eq(vExact.tolerated, false, 'validator: 严格等值路径不标记容差');
eq(vExact.alignSegments, exactSegments, 'validator: 严格等值路径沿用模型分段');

const vDrift = validateSegmentation(driftOriginal, driftBreaks, limits);
eq(vDrift.ok, true, 'validator: 标点/大小写偏差放行');
eq(vDrift.contentOk, true, 'validator: 偏差在容差内 contentOk');
eq(vDrift.tolerated, true, 'validator: 标记为容差放行');
eq(vDrift.alignSegments, driftExpected, 'validator: 对齐用原文切片');
eq(vDrift.similarity, 1, 'validator: 骨架一致相似度为 1');
eq(vDrift.feedback, '', 'validator: 放行时无反馈');

// 超长检查针对对齐分段：容差内的偏差同样要被限长约束。
const vDriftLong = validateSegmentation(
  driftOriginal,
  [
    driftBreaks[0],
    driftBreaks[1],
    driftBreaks[2],
    driftBreaks.slice(3).join(' '),
  ],
  limits,
);
eq(vDriftLong.contentOk, true, 'validator: 偏差放行但仍检查限长');
eq(vDriftLong.ok, false, 'validator: 超长段使其不 ok');
eq(vDriftLong.lengthViolations.length, 1, 'validator: 只有合并出的超长段违规');
ok(
  vDriftLong.feedback.includes('Length violations') &&
    !vDriftLong.feedback.includes('Content was modified'),
  'validator: 反馈只提长度，不提内容被改',
);

// 真被改写的内容仍然被拒绝并定位（既有行为）。
const vRewritten = validateSegmentation(
  driftOriginal,
  driftBreaks.slice(0, 3),
  limits,
);
eq(vRewritten.contentOk, false, 'validator: 丢掉大半文本仍判内容不通过');
ok(
  vRewritten.feedback.includes('Content was modified'),
  'validator: 被拒绝时仍给出定位反馈',
);

// 同等条件下严格等值优于容差放行。
const cmpExact = validateSegmentation(longCjk, [longCjk], limits);
const cmpTolerated = { ...cmpExact, tolerated: true };
ok(
  compareValidations(cmpExact, cmpTolerated) > 0 &&
    compareValidations(cmpTolerated, cmpExact) < 0,
  'compare: 其余相同时严格等值优先于容差放行',
);

// ---------------- validator · 被拒绝时如实报告相似度并逐处定位（#507 后续） ----------------
//
// 失败路径原先只用「公共前后缀」估算相似度：首尾各有一处改动，中间就全被算成不同，
// 一份 94.5% 吻合的答案在日志里写成 4.1%，重试反馈也只提第一处。下面用同一份文本钉住
// 新行为：约 200 词的窗口，模型把其中十个词换成了同义词，其余逐字照抄。

const lectureOriginal =
  'So today I want to talk about how we think about memory in modern computers. ' +
  'When a program starts, the operating system gives it a block of virtual memory, and that block is split into small pages. ' +
  'Each page can live in physical memory or it can be pushed out to disk when the machine runs low. ' +
  'Now, the interesting part is that the program never sees any of that. ' +
  'It just reads and writes addresses as if it owned the whole machine. ' +
  'The hardware translates every address on the fly, using a small cache called the translation lookaside buffer. ' +
  'If the translation is already cached, the access is fast. ' +
  'If it is not, the processor has to walk the page table, which can take hundreds of cycles. ' +
  'This is why locality matters so much. ' +
  'Programs that touch memory in a predictable order get far better performance than programs that jump around. ' +
  'I have seen simple loops run ten times faster just by changing the order of two nested indices. ' +
  'So before you reach for a clever algorithm, check how your data is laid out in memory, because that is usually where the real cost hides.';
const lectureEdits: Array<[string, string]> = [
  ['talk', 'speak'],
  ['block', 'chunk'],
  ['pushed out', 'moved out'],
  ['interesting', 'important'],
  ['translates', 'converts'],
  ['hundreds', 'dozens'],
  ['predictable', 'regular'],
  ['ten times faster', 'much faster'],
  ['clever', 'fancy'],
  ['usually', 'often'],
];
/** 模型的回答：按给定的改动改写原文，再每 12 个词断一次。 */
function lectureCopy(edits: Array<[string, string]>): string[] {
  let text = lectureOriginal;
  for (const [from, to] of edits) text = text.replace(from, to);
  const words = text.split(/\s+/);
  const segments: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    segments.push(words.slice(i, i + 12).join(' '));
  }
  return segments;
}

const vScattered = validateSegmentation(
  lectureOriginal,
  lectureCopy(lectureEdits),
  unlimitedLimits,
);
eq(
  vScattered.contentOk,
  false,
  'diagnostics: 十处零散改词（94.5%）低于 0.96，仍判被改写',
);
eq(
  vScattered.similarityExact,
  true,
  'diagnostics: 差异在诊断预算内，相似度是精确值',
);
ok(
  Math.abs(vScattered.similarity - 0.945) < 0.005,
  `diagnostics: 相似度如实反映 94.5%，而不是首尾区间估算的低值（实际 ${vScattered.similarity}）`,
);
eq(
  formatSimilarity(vScattered),
  '94.5%',
  'diagnostics: 日志里的相似度写成 94.5%',
);

const scatteredLines = vScattered.feedback.split('\n');
ok(
  scatteredLines[0].startsWith(
    'Content was modified (94.5% of the letters match, 96% required; 10 differences)',
  ),
  `diagnostics: 反馈首行给出真实相似度、阈值与差异处数（实际 ${scatteredLines[0].slice(0, 100)}）`,
);
ok(
  scatteredLines[0].includes('[talk]') &&
    scatteredLines[0].includes('"[speak]"'),
  'diagnostics: 首行带上第一处差异（降级日志只取首行）',
);
for (const [from, to] of [
  ['block', 'chunk'],
  ['pushed', 'moved'],
  ['interesting', 'important'],
  ['translates', 'converts'],
]) {
  ok(
    vScattered.feedback.includes(`[${from}]`) &&
      vScattered.feedback.includes(`"[${to}]"`),
    `diagnostics: 反馈逐处列出 ${from} → ${to}`,
  );
}
ok(
  vScattered.feedback.includes('and 5 more'),
  'diagnostics: 超过 5 处时注明还有几处',
);
ok(
  !vScattered.feedback.includes('[hundreds]'),
  'diagnostics: 只展示前 5 处，不把整页差异塞给模型',
);
ok(
  vScattered.feedback.includes('Keep the original text EXACTLY unchanged'),
  'diagnostics: 仍以「逐字不变」的要求收尾',
);

// 相似度的口径与放行判定一致：容差内的偏差照旧精确，差异不大的改写也是精确值。
eq(formatSimilarity(vDrift), '100.0%', 'diagnostics: 容差放行的相似度格式不变');

// 被整段重写（中间 40%，首尾完好）：真实相似度只有约 60%，已超出诊断预算。
const middleRewritten = (() => {
  const words = lectureOriginal.split(' ');
  const from = Math.floor(words.length * 0.3);
  const to = Math.floor(words.length * 0.7);
  return [
    words
      .map((word, i) => (i >= from && i < to ? 'x'.repeat(word.length) : word))
      .join(' '),
  ];
})();
const vMiddle = validateSegmentation(
  lectureOriginal,
  middleRewritten,
  unlimitedLimits,
);
eq(vMiddle.contentOk, false, 'diagnostics: 中段被重写判被改写');
eq(
  vMiddle.similarityExact,
  false,
  'diagnostics: 超出诊断预算时相似度不是精确值',
);
eq(
  formatSimilarity(vMiddle),
  '<75%',
  'diagnostics: 超出预算只写「<75%」，不编造百分比',
);
ok(
  vMiddle.similarity <= REPORT_MIN_SIMILARITY,
  'diagnostics: 非精确相似度不超过预算下限，排序时不会压过精确值',
);
ok(
  vMiddle.feedback.split('\n')[0].includes('below 75%'),
  'diagnostics: 被大幅改写时首行说明低于 75%',
);
ok(
  vMiddle.feedback.split('\n')[0].includes(' was changed to "[x'),
  'diagnostics: 被大幅改写时整块区域按原样写法给出，可直接阅读',
);
ok(
  vMiddle.feedback.includes('Keep the original text EXACTLY unchanged'),
  'diagnostics: 被大幅改写时同样以「逐字不变」收尾',
);

// 排序用真实相似度：十处零散改词（94.5%）比「中段整段重写」（约 60%）更接近原文。
ok(
  compareValidations(vScattered, vMiddle) > 0 &&
    compareValidations(vMiddle, vScattered) < 0,
  'compare: 十处零散改词的答案优于中段被整段重写的答案',
);

// describeDifferences：纯函数层。
const reportSwap = describeDifferences(
  'the quick brown fox jumps over the lazy dog today',
  ['the quick brown fox leaps over the lazy dog today'],
);
eq(reportSwap?.hunks.length, 1, 'diff: 换一个词只有一处差异');
eq(reportSwap?.hunks[0].original, 'jumps', 'diff: 原文侧扩到整词');
eq(reportSwap?.hunks[0].produced, 'leaps', 'diff: 模型侧扩到整词');
ok(
  !!reportSwap?.hunks[0].before.endsWith('fox ') &&
    !!reportSwap?.hunks[0].after.startsWith(' over'),
  'diff: 差异带着前后文',
);

const reportInsert = describeDifferences('we measured the latency twice', [
  'we measured the p99 latency twice',
]);
eq(reportInsert?.hunks.length, 1, 'diff: 多出一个词只有一处差异');
eq(reportInsert?.hunks[0].original, '', 'diff: 词间插入时原文侧为空');
eq(reportInsert?.hunks[0].produced, 'p99', 'diff: 词间插入时给出插入的词');
ok(
  !!reportInsert?.hunks[0].before.trimEnd().endsWith('the') &&
    !!reportInsert?.hunks[0].after.trimStart().startsWith('latency'),
  'diff: 插入点落在词与词之间，而不是粘在前一个词上',
);

const reportDelete = describeDifferences('we measured the very latency twice', [
  'we measured the latency twice',
]);
eq(reportDelete?.hunks.length, 1, 'diff: 少一个词只有一处差异');
eq(reportDelete?.hunks[0].original, 'very', 'diff: 词间删除时给出被删的词');
eq(reportDelete?.hunks[0].produced, '', 'diff: 词间删除时模型侧为空');

const reportCjk = describeDifferences('我们在生产环境里遇到了一个奇怪的问题', [
  '我们在生产环境里遇到了一个特怪的问题',
]);
eq(reportCjk?.hunks.length, 1, 'diff: CJK 改一个字只有一处差异');
eq(reportCjk?.hunks[0].original, '奇', 'diff: CJK 不扩词，只指出被改的字');
eq(reportCjk?.hunks[0].produced, '特', 'diff: CJK 模型侧同样只给被改的字');
ok(
  !!reportCjk?.hunks[0].before.endsWith('一个') &&
    !!reportCjk?.hunks[0].after.startsWith('怪'),
  'diff: CJK 差异带着前后文',
);

const reportLecture = describeDifferences(
  lectureOriginal,
  lectureCopy(lectureEdits),
);
eq(
  reportLecture?.hunks.map((hunk) => hunk.original),
  [
    'talk',
    'block',
    'pushed',
    'interesting',
    'translates',
    'hundreds',
    'predictable',
    'ten times',
    'clever',
    'usually',
  ],
  'diff: 十处改动按原文顺序逐处给出，词内碎片合并成一处',
);
eq(
  reportLecture?.hunks.map((hunk) => hunk.produced),
  [
    'speak',
    'chunk',
    'moved',
    'important',
    'converts',
    'dozens',
    'regular',
    'much',
    'fancy',
    'often',
  ],
  'diff: 模型侧与原文侧一一对应',
);

// 与放行判定同口径：容差内的偏差，诊断给出同一个相似度，并只列出真正改过的词。
const reportTypo = describeDifferences(driftOriginal, typoBreaks);
eq(
  reportTypo?.similarity,
  anchoredTypo?.similarity,
  'diff: 容差内的相似度与重锚定一致',
);
eq(
  reportTypo?.hunks.map((hunk) => [hunk.original, hunk.produced]),
  [
    ['forty', 'fourty'],
    ['next', 'nxt'],
  ],
  'diff: 个别字母被改只列出那两个词',
);
eq(
  describeDifferences(driftOriginal, driftBreaks),
  { similarity: 1, exact: true, hunks: [] },
  'diff: 只差标点与大小写时没有差异可列',
);

// 超出预算（整段被改写）：不逐处比对，只报公共开头与结尾之间的整块区域，
// 相似度是下界，exact = false。
const reportGarbage = describeDifferences(lectureOriginal, [
  'Sorry, I am unable to help with that request.',
]);
eq(reportGarbage?.exact, false, 'diff: 完全无关的文本不逐处比对');
ok(
  (reportGarbage?.similarity ?? 1) < REPORT_MIN_SIMILARITY,
  'diff: 超出预算时相似度只是低于预算下限的下界',
);
eq(reportGarbage?.hunks.length, 1, 'diff: 超出预算时只有一处（整块）');
ok(
  !!reportGarbage?.hunks[0].original.startsWith('today I want to talk'),
  'diff: 整块区域按原文写法给出（带空格），而不是去掉空白的字母串',
);
eq(
  reportGarbage?.hunks[0].produced,
  'Sorry, I am unable to help with that request',
  'diff: 模型侧同样是带原样写法的整块文本（收尾标点在区域之外）',
);

const reportMiddle = describeDifferences(lectureOriginal, middleRewritten);
eq(reportMiddle?.exact, false, 'diff: 中段被重写超出预算');
eq(reportMiddle?.hunks.length, 1, 'diff: 中段被重写只报一块');
ok(
  !!reportMiddle?.hunks[0].produced.startsWith('x') &&
    !!reportMiddle?.hunks[0].original.includes(' '),
  'diff: 整块区域从被重写的第一个词开始',
);
// 下界永远不高于真实相似度（最长公共子序列不短于公共首尾）。
ok(
  (reportMiddle?.similarity ?? 1) <= 0.6 + 1e-9 &&
    (reportMiddle?.similarity ?? 0) > 0.5,
  `diff: 中段 40% 被重写时下界约等于首尾占比（实际 ${reportMiddle?.similarity}）`,
);

eq(describeDifferences('', ['abc']), null, 'diff: 空原文返回 null');
eq(describeDifferences('abc', []), null, 'diff: 空输出返回 null');
eq(
  describeDifferences('abc', ['...', '!!']),
  null,
  'diff: 输出没有字母数字返回 null',
);

// 没有可比对内容时仍给出反馈（模型只回了标点）。
const vNoLetters = validateSegmentation('abc def', ['...', '!!'], limits);
eq(vNoLetters.contentOk, false, 'validator: 输出没有字母数字判不通过');
eq(vNoLetters.similarity, 0, 'validator: 没有可比对内容相似度为 0');
eq(vNoLetters.similarityExact, true, 'validator: 没有可比对内容时 0 是精确值');
ok(
  vNoLetters.feedback.includes('Content was modified') &&
    vNoLetters.feedback.includes('Keep the original text EXACTLY unchanged'),
  'validator: 没有可比对内容时仍给出反馈',
);

// 差异很大的大窗口也要有上限：诊断只花毫秒级，不会拖住主进程。
{
  const bigOriginal = Array.from(
    { length: 600 },
    (_, i) => `word${i % 97}x${(i * 7) % 13}`,
  ).join(' ');
  const bigWrecked = bigOriginal
    .split(' ')
    .map((word, i) => (i % 3 === 0 ? 'zzzzzzzz' : word))
    .join(' ');
  const startedAt = Date.now();
  const bigReport = describeDifferences(bigOriginal, [bigWrecked]);
  const elapsed = Date.now() - startedAt;
  eq(bigReport?.exact, false, 'diff: 三分之一的词被换掉超出预算');
  ok(elapsed < 2000, `diff: 大窗口被大幅改写时诊断有上限（${elapsed}ms）`);
}

// 固定种子的随机性质测试：手写例子覆盖不到的 Unicode / 标点边界错位靠它抓。
{
  let seed = 20260928;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const int = (lo: number, hi: number): number =>
    lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)];

  const LATIN = [
    ...'the first thing we did was add a cache layer in front of database and that alone cut response time by almost forty percent'.split(
      ' ',
    ),
    'café',
    'naïve',
    "don't",
    'U.S.',
    '50%',
    '$5',
    '(note)',
    '"quoted"',
    'ﬁne',
    'Ｈｅｌｌｏ',
  ];
  const CJK = Array.from(
    '我们在生产环境里面遇到了一个特别奇怪的问题就是每次到晚上八点左右整个服务的响应时间就会突然涨上去',
  );
  const ASTRAL = ['𠀀', '𠀁', '😀'];
  const PUNCT = ['', '', '', ',', '.', '!', '?', ';', '…', '。', '，'];

  const skeleton = (text: string): string =>
    Array.from(text.normalize('NFKD').toLowerCase())
      .filter((ch) => /[\p{L}\p{N}\p{M}]/u.test(ch))
      .join('');
  const squash = (text: string): string => text.replace(/\s+/g, '');
  const hasLoneSurrogate = (text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  };

  /** 独立的真实骨架相似度：不裁首尾、不设预算的完整 diff。 */
  const trueSimilarity = (a: string, b: string): number => {
    const x = Array.from(skeleton(a));
    const y = Array.from(skeleton(b));
    let edits = 0;
    for (const change of diffArrays(x, y)) {
      if (change.added || change.removed) edits += change.count ?? 0;
    }
    return 1 - edits / (x.length + y.length);
  };

  const problems: string[] = [];
  const stats = {
    wild: 0,
    wildAccepted: 0,
    faithful: 0,
    faithfulRejected: 0,
    exactReports: 0,
    coarseReports: 0,
    oracleChecks: 0,
  };

  for (let iteration = 0; iteration < 4000; iteration++) {
    const kind = pick(['latin', 'cjk', 'mixed']);
    const words: string[] = [];
    for (let i = int(20, 100); i > 0; i--) {
      if (kind === 'cjk' || (kind === 'mixed' && rnd() < 0.5)) {
        let word = '';
        for (let k = int(1, 4); k > 0; k--) {
          word += rnd() < 0.05 ? pick(ASTRAL) : pick(CJK);
        }
        words.push(word + pick(PUNCT));
      } else {
        words.push(pick(LATIN) + pick(PUNCT));
      }
    }
    const joiner = kind === 'cjk' ? '' : ' ';
    const original = words.join(joiner);

    const cuts = new Set<number>();
    for (let b = int(0, 10); b > 0; b--) cuts.add(int(1, words.length - 1));
    const bounds = [...cuts].sort((x, y) => x - y).concat(words.length);

    const mode = pick([
      'exact',
      'nopunct',
      'nopunct',
      'edits',
      'wild',
      'rewrite',
    ]);
    const produced: string[] = [];
    let from = 0;
    for (const cut of bounds) {
      let segment = words.slice(from, cut).join(joiner);
      from = cut;
      if (mode !== 'exact') {
        segment = segment.replace(/[\p{P}\p{S}]/gu, '').toLowerCase();
      }
      if (mode === 'edits' && segment.length > 4 && rnd() < 0.3) {
        const chars = Array.from(segment);
        const at = int(1, chars.length - 2);
        if (/\p{L}/u.test(chars[at])) chars[at] = chars[at] + chars[at];
        segment = chars.join('');
      }
      if (mode === 'wild') {
        segment = Array.from(segment)
          .filter(() => rnd() > 0.15)
          .join('');
      }
      if (mode === 'rewrite' && rnd() < 0.5) {
        // 倒序（按码点）：字母一样多、顺序全乱，相当于整段被改写。
        segment = Array.from(segment).reverse().join('');
      }
      if (segment.trim()) produced.push(segment);
    }

    let anchored: ReturnType<typeof anchorSegmentsToOriginal>;
    try {
      anchored = anchorSegmentsToOriginal(original, produced);
    } catch (error) {
      problems.push(`threw on ${JSON.stringify({ original, produced })}`);
      continue;
    }

    // 诊断（describeDifferences）：不抛异常；相似度与独立的完整 diff 一致（超出预算时是
    // 不高于它的下界）；逐处差异里没有被劈开的代理对，也没有两侧都为空的空差异。
    let report: ReturnType<typeof describeDifferences>;
    try {
      report = describeDifferences(original, produced);
    } catch (error) {
      problems.push(
        `describeDifferences threw on ${JSON.stringify({ original, produced })}`,
      );
      continue;
    }
    if (report) {
      if (report.exact) stats.exactReports++;
      else stats.coarseReports++;
      const oracle =
        iteration % 4 === 0
          ? trueSimilarity(original, produced.join(' '))
          : null;
      if (oracle !== null) stats.oracleChecks++;
      const fragments = report.hunks.flatMap((hunk) => [
        hunk.before,
        hunk.original,
        hunk.produced,
        hunk.after,
      ]);
      const where = JSON.stringify({ original, produced, report });
      if (fragments.some(hasLoneSurrogate)) {
        problems.push(`lone surrogate in a hunk: ${where}`);
      } else if (
        report.hunks.some((hunk) => !hunk.original && !hunk.produced)
      ) {
        problems.push(`empty hunk: ${where}`);
      } else if (report.exact && report.similarity < REPORT_MIN_SIMILARITY) {
        problems.push(`exact report below the budget floor: ${where}`);
      } else if (
        !report.exact &&
        (report.similarity >= REPORT_MIN_SIMILARITY ||
          report.hunks.length !== 1)
      ) {
        problems.push(
          `coarse report is not one region under the floor: ${where}`,
        );
      } else if (
        report.exact &&
        report.similarity < 1 &&
        !report.hunks.length
      ) {
        problems.push(`similarity below 1 without a difference: ${where}`);
      } else if (
        report.exact &&
        report.hunks.some(
          (hunk) => skeleton(hunk.original) === skeleton(hunk.produced),
        )
      ) {
        problems.push(`a hunk without a difference: ${where}`);
      } else if (
        anchored &&
        (!report.exact || report.similarity !== anchored.similarity)
      ) {
        problems.push(`report disagrees with the anchor: ${where}`);
      } else if (
        oracle !== null &&
        report.exact &&
        Math.abs(report.similarity - oracle) > 1e-9
      ) {
        problems.push(
          `similarity ${report.similarity} != full diff ${oracle}: ${where}`,
        );
      } else if (
        oracle !== null &&
        !report.exact &&
        !(report.similarity <= oracle + 1e-9 && oracle < REPORT_MIN_SIMILARITY)
      ) {
        problems.push(`lower bound above the full diff ${oracle}: ${where}`);
      }
    }

    if (mode === 'wild') {
      stats.wild++;
      if (anchored) stats.wildAccepted++;
    }
    if (mode === 'exact' || mode === 'nopunct') {
      stats.faithful++;
      if (!anchored) {
        stats.faithfulRejected++;
        problems.push(`rejected a faithful copy ${JSON.stringify(produced)}`);
        continue;
      }
    }
    if (!anchored) continue;

    // 不丢字、不重复、不产生空段或被切开的代理对。
    if (squash(anchored.segments.join('')) !== squash(original)) {
      problems.push(`text lost/duplicated: ${JSON.stringify(anchored)}`);
    } else if (
      anchored.segments.some((s) => !s.trim() || hasLoneSurrogate(s))
    ) {
      problems.push(`bad segment: ${JSON.stringify(anchored.segments)}`);
    } else if (
      (mode === 'exact' || mode === 'nopunct') &&
      JSON.stringify(anchored.segments.map(skeleton)) !==
        JSON.stringify(produced.map(skeleton).filter(Boolean))
    ) {
      // 只丢标点/改大小写时，断点必须落在模型给的位置上。
      problems.push(`breaks moved: ${JSON.stringify({ produced, anchored })}`);
    }
  }

  eq(problems.slice(0, 3), [], 'anchor 随机性质: 无丢字/错位/异常');
  ok(
    stats.exactReports > 1000 && stats.coarseReports > 100,
    `diff 随机性质: 精确 / 超出预算两类报告样本量足够（${stats.exactReports} / ${stats.coarseReports}）`,
  );
  ok(
    stats.oracleChecks > 500,
    'diff 随机性质: 与独立的完整 diff 核对的样本量足够',
  );
  eq(stats.faithfulRejected, 0, 'anchor 随机性质: 只丢标点/大小写从不被拒绝');
  ok(stats.faithful > 1000, 'anchor 随机性质: 忠实样本量足够');
  ok(
    stats.wildAccepted / stats.wild < 0.02,
    'anchor 随机性质: 随机丢 15% 字符基本全部被拒绝',
  );
}

// ---------------- alignment · 精确（词级） ----------------

// 例：犹豫停顿劈开数字（「三」与「十五天」间 550ms，规则会切开；语义断句应可跨越）。
const case3Text = '整个迁移过程一共花了三十五天比我们原来的预期要快得多';
const case3Words = cjkWords(case3Text, { gaps: { 11: 550, 14: 400 } });
const case3Aligned = alignSegmentsToWords(case3Words, [
  '整个迁移过程',
  '一共花了三十五天',
  '比我们原来的预期要快得多',
]);
ok(case3Aligned !== null, 'align-word: 对齐成功');
eq(case3Aligned!.length, 3, 'align-word: 三条');
eq(case3Aligned![1].cue[2], '一共花了三十五天', 'align-word: 语义单元跨停顿');
eq(case3Aligned![1].cue[0], '00:00:01,320', 'align-word: 起点为首词真实时间');
eq(case3Aligned![1].cue[1], '00:00:03,630', 'align-word: 末点为末词真实时间');
eq(case3Aligned![1].words!.length, 8, 'align-word: 携带词切片');

// 断点插进词内部：吸附到词末，debt 从下一段扣除。
const snapAligned = alignSegmentsToWords(enWords('hello world'), [
  'hel',
  'lo world',
]);
ok(snapAligned !== null, 'align-word: 词内断点可对齐');
eq(
  snapAligned!.map((a) => a.cue[2]),
  ['hello', 'world'],
  'align-word: 词内断点吸附词边界',
);

eq(
  alignSegmentsToWords(cjkWords('大家好'), ['大家', '好呀']),
  null,
  'align-word: 字符不一致返回 null（防御）',
);

// ---------------- alignment · 近似（cue 级） ----------------

const approxCues: TokenTriple[] = [
  ['00:00:00,000', '00:00:04,000', '大家好今天我们聊聊'],
  ['00:00:04,000', '00:00:08,000', '如何用三十天学会一门语言'],
];
const approxAligned = alignSegmentsToCues(approxCues, [
  '大家好',
  '今天我们聊聊如何用三十天',
  '学会一门语言',
]);
ok(approxAligned !== null, 'align-cue: 对齐成功');
eq(approxAligned!.length, 3, 'align-cue: 三条');
eq(approxAligned![0][0], '00:00:00,000', 'align-cue: 首条起点沿用 cue 边界');
eq(approxAligned![1][0], '00:00:01,333', 'align-cue: 条内切点比例插值');
eq(approxAligned![1][1], '00:00:06,000', 'align-cue: 跨条末点插值');
eq(approxAligned![2][1], '00:00:08,000', 'align-cue: 末条末点沿用 cue 边界');

eq(
  alignSegmentsToCues(approxCues, ['内容对不上']),
  null,
  'align-cue: 字符不一致返回 null',
);

// ---------------- windowing ----------------

const uniform = cjkWords('字'.repeat(1200));
const uniformWindows = splitWordsIntoWindows(uniform);
eq(
  uniformWindows.map((w) => w.length),
  [300, 300, 300, 300],
  'window: 均匀语流按物色区起点切（300–500 目标内）',
);
eq(
  uniformWindows.reduce((sum, w) => sum + w.length, 0),
  1200,
  'window: 词无丢失',
);

const gapped = cjkWords('字'.repeat(700), { gaps: { 100: 5000 } });
const gappedWindows = splitWordsIntoWindows(gapped);
eq(gappedWindows[0].length, 100, 'window: 章节级停顿提前切');

eq(
  splitWordsIntoWindows(cjkWords('短句')).map((w) => w.length),
  [2],
  'window: 短于上限不分窗',
);

const manyCues: TokenTriple[] = [];
for (let i = 0; i < 60; i += 1) {
  manyCues.push([
    `00:00:${String(i).padStart(2, '0')},000`,
    `00:00:${String(i).padStart(2, '0')},900`,
    '一二三四五六七八九十',
  ]);
}
const cueRanges = splitCuesIntoWindows(manyCues);
ok(cueRanges.length > 1, 'window-cue: 长列表分多窗');
eq(cueRanges[0][0], 0, 'window-cue: 首窗从 0 起');
eq(cueRanges[cueRanges.length - 1][1], 60, 'window-cue: 末窗覆盖到结尾');

// ---------------- guards ----------------

// 超宽 cue（30 字 = 宽度 60 > 40）带词级支撑 → 在真实词时间上重切，且不因词间停顿再碎。
const wideText =
  '这是一条特别长的字幕内容它包含了很多很多的文字需要被护栏重新切分';
const wideWords = cjkWords(wideText, { gaps: { 10: 700 } });
const guarded = applySegmentationGuards(
  [
    {
      cue: ['00:00:00,000', '00:00:09,000', wideText],
      words: wideWords,
    },
  ],
  { cueOptions: { maxWidth: 40 } },
);
ok(guarded.length >= 2, 'guards: 超宽被重切');
ok(
  guarded.every((c) => Array.from(c[2]).length * 2 <= 40),
  'guards: 重切后每条不超宽',
);
eq(guarded.map((c) => c[2]).join(''), wideText, 'guards: 重切不丢字');

// 词间 700ms 停顿不应导致语义组合被 gap 重新切碎（gap 切分已关闭）——
// 用一条不超宽、内部含大停顿的 cue 验证原样保留。
const pauseText = '一共花了三十五天';
const pauseWords = cjkWords(pauseText, { gaps: { 5: 700 } });
const pauseGuarded = applySegmentationGuards(
  [
    {
      cue: ['00:00:00,000', '00:00:02,460', pauseText],
      words: pauseWords,
    },
  ],
  { cueOptions: { maxWidth: 40 } },
);
eq(pauseGuarded.length, 1, 'guards: 合规 cue 不被 gap 二次切碎');
eq(pauseGuarded[0][2], pauseText, 'guards: 合规 cue 文本原样');

const preservedPause = applySegmentationGuards(
  [{ cue: ['00:00:00,000', '00:00:02,460', pauseText], words: pauseWords }],
  {
    cueOptions: { maxWidth: 40, maxGapSeconds: 0.25 },
    preserveSpeechPauses: true,
  },
);
ok(
  preservedPause.length > 1,
  'guards: explicit pause preservation also splits otherwise compliant AI cues',
);
eq(
  preservedPause.map((cue) => cue[2]).join(''),
  pauseText,
  'guards: pause split preserves text',
);
const toMs = (t: string) => {
  const [h, m, s] = t.replace(',', '.').split(':').map(Number);
  return Math.round((h * 3600 + m * 60 + s) * 1000);
};
ok(
  preservedPause.some(
    (cue, i) => i > 0 && toMs(cue[0]) - toMs(preservedPause[i - 1][1]) >= 700,
  ),
  'guards: no merge or display extension consumes pause',
);
const pauseRanges = splitCuesIntoWindows(
  [
    ['00:00:00,000', '00:00:00,200', 'First'],
    ['00:00:00,600', '00:00:00,800', 'I'],
    ['00:00:01,200', '00:00:01,500', 'agree'],
  ],
  { preserveGapMs: 250 },
);
eq(
  pauseRanges,
  [
    [0, 1],
    [1, 2],
    [2, 3],
  ],
  'window-cue: segment-only AI cannot merge across explicit pause boundaries',
);
const durationGuarded = applySegmentationGuards(
  [
    {
      cue: [
        '00:00:00,000',
        '00:00:09,000',
        'This sentence has many words and takes a long time to say',
      ],
    },
  ],
  { cueOptions: { maxWidth: Infinity, maxDurationSeconds: 3 } },
);
ok(
  durationGuarded.length >= 3,
  'guards: segment-only duration cap works without width limit',
);
ok(
  durationGuarded.every((cue) => toMs(cue[1]) - toMs(cue[0]) <= 3001),
  'guards: duration cap survives fragment merge and display extension',
);

// 无词级支撑的超宽 cue：走文本级比例插值兜底。
const approxGuarded = applySegmentationGuards(
  [
    {
      cue: [
        '00:00:00,000',
        '00:00:06,000',
        '这是一条没有词级时间戳支撑的特别长的字幕内容需要文本级兜底切分',
      ],
    },
  ],
  { cueOptions: { maxWidth: 40 } },
);
ok(approxGuarded.length >= 2, 'guards: 近似模式超宽兜底切分');

// 最短显示时长：过短 cue 的末点向后延展（不与下一条重叠）。
const shortGuarded = applySegmentationGuards(
  [
    { cue: ['00:00:00,000', '00:00:00,200', '短'] },
    { cue: ['00:00:05,000', '00:00:06,000', '下一条字幕在很远处'] },
  ],
  {},
);
ok(
  (() => {
    const [s, e] = [shortGuarded[0][0], shortGuarded[0][1]];
    const toSec = (t: string) => {
      const [h, m, rest] = t.split(':');
      return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.'));
    };
    return toSec(e) - toSec(s) >= 0.7;
  })(),
  'guards: 最短显示时长延展',
);

// ---------------- suspect words ----------------

ok(
  collectSuspectWords([
    { text: 'hello', start: 0, end: 100, p: 0.2 },
    { text: 'world', start: 100, end: 200, p: 0.9 },
    { text: 'hello', start: 200, end: 300, p: 0.1 },
  ]).join(',') === 'hello',
  'suspect: 低置信去重',
);

ok(
  filterSuspectWordsForBatch(['hello', 'ghost'], ['say hello there']).join(
    ',',
  ) === 'hello',
  'suspect: 仅保留本批出现的词',
);

// ---------------- summary ----------------

console.log(`\nrefine units: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
