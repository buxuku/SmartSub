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
import { validateSegmentation } from '../main/helpers/subtitleRefine/validator';
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
