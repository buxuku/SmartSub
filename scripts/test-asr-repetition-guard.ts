/**
 * 模型无关 ASR 重复护栏单元测试（无 Electron / 无模型依赖）。
 *
 * 运行：npm run test:asr-repetition-guard
 */
import {
  applyAsrRepetitionGuard,
  formatRepetitionGuardDiagnostic,
  getAsrRepetitionGuardMode,
  normalizeAsrText,
  type AsrSubtitleCue,
} from '../main/helpers/asrRepetitionGuard';
import { guardAsrSubtitleCues } from '../main/helpers/engines/transcribeShared';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`✗ ${name}\n    expected: ${e}\n    actual:   ${a}`);
}

function cueTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function repetitionCues(texts: string[], gapSeconds = 0): AsrSubtitleCue[] {
  let cursor = 0;
  return texts.map((text) => {
    const start = cursor;
    const end = start + 2;
    cursor = end + gapSeconds;
    return [cueTime(start), cueTime(end), text];
  });
}

eq(
  applyAsrRepetitionGuard([]).stats,
  {
    inputCues: 0,
    outputCues: 0,
    removedCues: 0,
    detectedRuns: 0,
    removedDurationSeconds: 0,
    removedByReason: { sliding: 0, exact: 0, cycle: 0 },
  },
  'empty input',
);

const blankCues = repetitionCues(['', '   ', '...', '']);
eq(
  applyAsrRepetitionGuard(blankCues).cues,
  blankCues,
  'empty and punctuation-only cues stay unchanged',
);

const normalDialogue = repetitionCues([
  '欢迎来到今天的课程，我们先回顾上一节内容。',
  '接下来会介绍安装步骤和常见配置。',
  '如果看到这个页面，说明服务已经启动成功。',
  '最后保存设置，然后重新运行一次任务。',
]);
eq(
  applyAsrRepetitionGuard(normalDialogue).cues,
  normalDialogue,
  'normal CJK dialogue stays unchanged',
);

const intentionalShortRepeat = repetitionCues(
  Array.from({ length: 8 }, () => '谢谢'),
);
eq(
  applyAsrRepetitionGuard(intentionalShortRepeat).cues.length,
  8,
  'intentional short phrase repetition is preserved',
);
eq(
  applyAsrRepetitionGuard(intentionalShortRepeat, { mode: 'aggressive' }).cues
    .length,
  8,
  'aggressive mode still preserves intentional short repetition',
);

// 复刻 issue #402 截图：同一长词窗每条向前滑动，首尾轮转。
const issue402SlidingLoop = repetitionCues([
  '转发 打赏支持明镜与点栏目周末愉快 转发',
  '打赏支持明镜与点栏目周末愉快 转发 打赏',
  '支持明镜与点栏目周末愉快 转发 打赏支持',
  '明镜与点栏目周末愉快 转发 打赏支持明镜与',
  '点栏目周末愉快 转发 打赏支持明镜与点栏目',
  '周末愉快 转发 打赏支持明镜与点栏目周末',
]);
eq(
  applyAsrRepetitionGuard(issue402SlidingLoop.slice(0, 3)).cues.length,
  3,
  'three similar cues stay below the sliding-loop threshold',
);
const issue402Guarded = applyAsrRepetitionGuard(issue402SlidingLoop);
eq(
  issue402Guarded.cues.length,
  2,
  'CJK sliding loop collapses after two cues in standard mode',
);
eq(
  issue402Guarded.cues,
  issue402SlidingLoop.slice(0, 2),
  'guard preserves the first two cues and their original timestamps/text',
);
eq(
  issue402Guarded.stats.removedByReason.sliding,
  4,
  'CJK sliding loop reports diagnostic reason',
);

const englishSlidingLoop = repetitionCues([
  'Please like share and subscribe to the channel',
  'Like share and subscribe to the channel please',
  'Share and subscribe to the channel please like',
  'And subscribe to the channel please like share',
  'Subscribe to the channel please like share and',
]);
eq(
  applyAsrRepetitionGuard(englishSlidingLoop).cues.length,
  2,
  'English sliding loop is detected',
);

const longExactPhrase = 'Please remember to review the complete project notes';
const exactSix = repetitionCues(
  Array.from({ length: 6 }, () => longExactPhrase),
);
eq(
  applyAsrRepetitionGuard(exactSix).cues.length,
  6,
  'public pure-function default is safest standard mode',
);
const exactGuarded = applyAsrRepetitionGuard(exactSix, {
  mode: 'aggressive',
});
eq(
  exactGuarded.cues.length,
  2,
  'aggressive mode keeps two cues from a long exact loop',
);
eq(
  exactGuarded.stats.removedByReason.exact,
  4,
  'exact-loop diagnosis is counted',
);

const cycleLoop = repetitionCues([
  'This is the first long sentence in the repeating window',
  'This is the second long sentence in the repeating window',
  'This is the first long sentence in the repeating window',
  'This is the second long sentence in the repeating window',
  'This is the first long sentence in the repeating window',
  'This is the second long sentence in the repeating window',
  'This is the first long sentence in the repeating window',
  'This is the second long sentence in the repeating window',
]);
eq(
  applyAsrRepetitionGuard(cycleLoop).cues.length,
  8,
  'standard mode preserves exact multi-cue cycles',
);
eq(
  applyAsrRepetitionGuard(cycleLoop, { mode: 'aggressive' }).cues.length,
  4,
  'aggressive mode keeps two complete multi-cue cycles',
);

const separatedRepeats = repetitionCues(
  Array.from({ length: 6 }, () => longExactPhrase),
  30,
);
eq(
  applyAsrRepetitionGuard(separatedRepeats, { mode: 'aggressive' }).cues.length,
  6,
  'repeats separated by long gaps are preserved',
);

eq(
  applyAsrRepetitionGuard(issue402SlidingLoop, { enabled: false }).cues,
  issue402SlidingLoop,
  'explicit disable is a no-op',
);
eq(
  getAsrRepetitionGuardMode(
    { subtitleOutcome: 'clean', transcriptionEngine: 'qwen' },
    {},
  ),
  'aggressive',
  'clean outcome enables aggressive guard for sherpa engines',
);
eq(
  getAsrRepetitionGuardMode({}, { reduceRepetition: false }),
  'off',
  'legacy/default task without explicit intent disables guard',
);
eq(
  getAsrRepetitionGuardMode(
    { subtitleOutcome: 'balanced' },
    { reduceRepetition: false },
  ),
  'off',
  'balanced outcome disables post-processing',
);
eq(
  getAsrRepetitionGuardMode(
    { subtitleOutcome: 'balanced', transcriptionEngine: 'qwen' },
    { reduceRepetition: true },
  ),
  'off',
  'explicit balanced outcome overrides stale global repetition setting',
);
eq(
  getAsrRepetitionGuardMode(
    { subtitleOutcome: 'custom', reduceRepetition: true },
    {},
  ),
  'aggressive',
  'custom reduceRepetition enables aggressive guard',
);
eq(
  getAsrRepetitionGuardMode(
    { subtitleOutcome: 'custom', reduceRepetition: false },
    { reduceRepetition: true },
  ),
  'off',
  'explicit custom reduceRepetition=false disables guard',
);
eq(
  guardAsrSubtitleCues(
    issue402SlidingLoop,
    { subtitleOutcome: 'balanced' },
    { reduceRepetition: false },
    'test',
  ).cues.length,
  6,
  'default balanced task path is a no-op',
);
eq(
  guardAsrSubtitleCues(
    issue402SlidingLoop,
    {},
    { reduceRepetition: false },
    'test',
  ).cues,
  issue402SlidingLoop,
  'legacy/default task path is a no-op',
);
eq(
  guardAsrSubtitleCues(
    exactSix,
    { subtitleOutcome: 'balanced' },
    { reduceRepetition: false },
    'test',
  ).cues.length,
  6,
  'balanced task path preserves exact repeats',
);
eq(
  guardAsrSubtitleCues(
    issue402SlidingLoop,
    { subtitleOutcome: 'clean' },
    { reduceRepetition: true },
    'test',
  ).cues.length,
  2,
  'clean task path collapses the issue #402 sliding loop',
);
eq(
  guardAsrSubtitleCues(
    exactSix,
    { subtitleOutcome: 'clean' },
    { reduceRepetition: true },
    'test',
  ).cues.length,
  2,
  'clean task path additionally collapses exact loops',
);

const rollingLyrics = repetitionCues([
  'You are my sunshine my only sunshine',
  'Are my sunshine my only sunshine you',
  'My sunshine my only sunshine you are',
  'Sunshine my only sunshine you are my',
]);
eq(
  guardAsrSubtitleCues(
    rollingLyrics,
    { subtitleOutcome: 'balanced' },
    { reduceRepetition: false },
    'test',
  ).cues,
  rollingLyrics,
  'balanced preserves legitimate rolling lyrics',
);
eq(
  guardAsrSubtitleCues(
    rollingLyrics,
    { subtitleOutcome: 'accurate' },
    { reduceRepetition: false },
    'test',
  ).cues,
  rollingLyrics,
  'accurate preserves legitimate rolling lyrics',
);

eq(
  normalizeAsrText('ＡＢＣ，週末 愉快！').compact,
  'abc週末愉快',
  'NFKC/case/punctuation normalization',
);
eq(
  normalizeAsrText('مرحبا بالعالم ١٢٣!').units,
  ['مرحبا', 'بالعالم', '١٢٣'],
  'Arabic letters and numbers are retained',
);
eq(
  normalizeAsrText('שלום, עולם 42!').units,
  ['שלום', 'עולם', '42'],
  'Hebrew letters and numbers are retained',
);
const diagnostic = formatRepetitionGuardDiagnostic(
  'test-engine',
  issue402Guarded.stats,
);
eq(
  Boolean(
    diagnostic?.includes('removed 4/6 cues') && !diagnostic.includes('明镜'),
  ),
  true,
  'diagnostic is useful without logging subtitle text',
);

console.log(`\nASR repetition guard tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
