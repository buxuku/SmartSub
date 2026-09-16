import assert from 'assert';
import {
  SCENARIO_PRESETS,
  applyScenarioPreset,
  detectCurrentPreset,
  getScenarioPresetDef,
  convertToCustomOutcome,
  type ScenarioPresetId,
} from '../renderer/lib/scenarioPresets';
import {
  resolveEffectiveSettings,
  TASK_VAD_FIELDS,
} from '../types/subtitleOutcome';
import { getVadSettings } from '../main/helpers/engines/transcribeShared';
import {
  layoutSubtitleText,
  layoutSubtitleColumns,
} from '../main/helpers/subtitleLayout';
import {
  composeWordCues,
  resplitSubtitleCues,
  parseTime,
  type TokenTriple,
} from '../main/helpers/subtitleSegmentation';

console.log('=== Running Scenario Presets Tests ===');

// 1. Verify preset definitions
assert(Array.isArray(SCENARIO_PRESETS), 'SCENARIO_PRESETS must be an array');
assert.strictEqual(
  SCENARIO_PRESETS.length,
  6,
  'Four business scenarios, balanced and custom',
);

const presetIds = SCENARIO_PRESETS.map((p) => p.id);
assert(presetIds.includes('interview'), 'Must contain interview preset');
assert(presetIds.includes('lecture'), 'Must contain lecture preset');
assert(presetIds.includes('movie'), 'Must contain movie preset');
assert(presetIds.includes('shortDrama'), 'Must contain short drama preset');
assert(presetIds.includes('balanced'), 'Must contain balanced preset');
assert(presetIds.includes('custom'), 'Must contain custom preset');

const interview = getScenarioPresetDef('interview');
assert(interview, 'interview preset def must exist');
assert.strictEqual(interview.fields.subtitleOutcome, 'clean');
assert.strictEqual(interview.fields.fasterWhisperBeamSize, 5);
assert.strictEqual(interview.fields.fasterWhisperTemperature, 0);
assert.strictEqual(interview.fields.useVAD, true);
assert.strictEqual(interview.fields.vadThreshold, 0.35);

const lecture = getScenarioPresetDef('lecture');
assert(lecture, 'lecture preset def must exist');
assert.strictEqual(lecture.fields.subtitleOutcome, 'clean');
assert.equal(lecture.fields.aiCorrection, true);
assert.equal(lecture.fields.subtitleFillerPolicy, 'remove-hesitations');
for (const transcriptionEngine of ['builtin', 'fasterWhisper']) {
  const effective = resolveEffectiveSettings(
    { ...lecture.fields, transcriptionEngine },
    {},
  );
  assert.equal(effective.useVAD, true);
  assert.equal(effective.reduceRepetition, true);
}
assert.strictEqual(lecture.fields.fasterWhisperBeamSize, 5);
assert.strictEqual(lecture.fields.fasterWhisperTemperature, 0);
assert.strictEqual(lecture.fields.fasterWhisperCompressionRatioThreshold, 2.2);
assert.strictEqual(lecture.fields.fasterWhisperLogProbThreshold, -0.8);

const movie = getScenarioPresetDef('movie');
assert(movie, 'movie preset def must exist');
assert.strictEqual(movie.fields.subtitleOutcome, 'balanced');
assert.strictEqual(movie.fields.fasterWhisperBeamSize, 3);
assert.strictEqual(movie.fields.fasterWhisperTemperature, 0.2);
assert.equal(movie.fields.subtitleFillerPolicy, 'preserve');
assert.equal(movie.fields.subtitleTranslationStyle, 'conversational');
const shortDrama = getScenarioPresetDef('shortDrama')!;
assert.equal(shortDrama.fields.subtitleTranslationStyle, 'conversational');
assert.equal(shortDrama.fields.preserveSpeechPauses, true);
assert.equal(shortDrama.fields.subtitleMaxDuration, 3);
assert.equal(shortDrama.fields.subtitleLayout, 'two-line');
assert.equal(movie.fields.subtitleLayout, 'two-line');
for (const text of [
  'Natural emotional dialogue should keep every word intact across both subtitle lines.',
  '我们现在开始讨论字幕排版，保留情绪和原来的时间轴。',
  'Mixed 中文 and English words should remain readable.',
  '这是SmartSub字幕排版系统English测试withoutspaces以及重试验证。',
  'ABCDEFGHIJK中文测试这是另外的一半中文字幕。',
  '[Speaker 1 + Speaker 2] Keep this overlapping speaker label intact with both voices.',
  'Family 👨‍👩‍👧‍👦 and cafe\u0301 should never be split inside a grapheme cluster.',
]) {
  const options = {
    subtitleLayout: 'two-line' as const,
    subtitleLineWidth: 32,
  };
  const wrapped = layoutSubtitleText(text, options);
  assert.equal(wrapped.split('\n').length, 2);
  assert.equal(wrapped.replace(/\s/g, ''), text.replace(/\s/g, ''));
  if (text.startsWith('[Speaker'))
    assert.ok(wrapped.startsWith('[Speaker 1 + Speaker 2] '));
  assert.equal(
    layoutSubtitleText(wrapped, options),
    wrapped,
    'layout retry is idempotent',
  );
}
assert.equal(
  layoutSubtitleText('Supercalifragilisticexpialidocious', {
    subtitleLayout: 'two-line',
    subtitleLineWidth: 16,
  }),
  'Supercalifragilisticexpialidocious',
);
assert.equal(layoutSubtitleText('Original\nlines', {}), 'Original\nlines');
assert.equal(
  layoutSubtitleText('[Speaker 1 + Speaker 2] Hi there', {
    subtitleLayout: 'two-line',
    subtitleLineWidth: 16,
  }).startsWith('[Speaker 1 + Speaker 2] '),
  true,
);
assert.equal(
  layoutSubtitleColumns('Source\nline', '目标\n文本', 'sourceAndTranslate', {
    subtitleLayout: 'two-line',
  }),
  'Source line\n目标文本',
);
assert.equal(
  layoutSubtitleColumns('Source\nline', '目标\n文本', 'translateAndSource', {
    subtitleLayout: 'two-line',
  }),
  '目标文本\nSource line',
);

const balanced = getScenarioPresetDef('balanced');
assert(balanced, 'balanced preset def must exist');
assert.strictEqual(balanced.fields.subtitleOutcome, 'balanced');

// 2. Test applyScenarioPreset
const mockFormValues: Record<string, any> = {};
const resetFields: string[] = [];
const mockForm = {
  setValue: (key: string, value: any) => {
    mockFormValues[key] = value;
  },
  resetField: (key: string) => {
    resetFields.push(key);
    delete mockFormValues[key];
  },
};

applyScenarioPreset(mockForm, 'interview');
assert.strictEqual(mockFormValues.scenarioPreset, 'interview');
assert.strictEqual(mockFormValues.subtitleOutcome, 'clean');
assert.strictEqual(mockFormValues.fasterWhisperBeamSize, 5);
assert.strictEqual(mockFormValues.fasterWhisperTemperature, 0);
assert.strictEqual(mockFormValues.useVAD, true);
assert.strictEqual(mockFormValues.vadThreshold, 0.35);

// Apply lecture next - verify previous custom interview fields are cleared or overridden
applyScenarioPreset(mockForm, 'lecture');
assert.strictEqual(mockFormValues.scenarioPreset, 'lecture');
assert.strictEqual(mockFormValues.subtitleOutcome, 'clean');
assert.strictEqual(mockFormValues.fasterWhisperCompressionRatioThreshold, 2.2);
assert.strictEqual(mockFormValues.fasterWhisperLogProbThreshold, -0.8);
assert.strictEqual(mockFormValues.useVAD, true);
assert.strictEqual(mockFormValues.vadThreshold, undefined);
assert(resetFields.includes('vadThreshold'), 'vadThreshold must be reset');

// 3. Test detectCurrentPreset
assert.strictEqual(detectCurrentPreset(mockFormValues), 'lecture');

// Explicitly overriding lecture VAD must show custom.
const lectureWithFalseVAD = { ...mockFormValues, useVAD: false };
assert.strictEqual(
  detectCurrentPreset(lectureWithFalseVAD),
  'custom',
  'useVAD: false changes the lecture preset',
);

// Tamper with one field: change temperature
const tamperedFormValues = { ...mockFormValues, fasterWhisperTemperature: 0.8 };
assert.strictEqual(detectCurrentPreset(tamperedFormValues), 'custom');

// Test interview detection
const interviewValues: Record<string, any> = {
  scenarioPreset: 'interview',
  ...interview.fields,
};
assert.strictEqual(detectCurrentPreset(interviewValues), 'interview');

// Tamper with interview: change beam size
assert.strictEqual(
  detectCurrentPreset({ ...interviewValues, fasterWhisperBeamSize: 10 }),
  'custom',
);

// Verify effective values, not only labels or serialized form fields.
for (const engine of [
  'builtin',
  'fasterWhisper',
  'funasr',
  'qwen',
  'fireRedAsr',
  'parakeet',
]) {
  const globalSettings = {
    vadThreshold: 0.8,
    vadSpeechPad: 130,
    maxContext: 10,
  };
  const before = structuredClone(globalSettings);
  const values = {
    ...interviewValues,
    transcriptionEngine: engine,
    vadMinSilenceDuration: 320,
  };
  const effective = resolveEffectiveSettings(values, globalSettings);
  assert.equal(effective.vadThreshold, 0.35, engine);
  assert.equal(effective.vadMinSilenceDuration, 320, engine);
  const custom = { ...values };
  convertToCustomOutcome(
    {
      setValue: (key, value) => {
        custom[key] = value;
      },
    },
    values,
    globalSettings,
  );
  assert.equal(custom.subtitleOutcome, 'custom');
  assert.equal(custom.scenarioPreset, 'custom');
  const customEffective = resolveEffectiveSettings(custom, globalSettings);
  assert.deepEqual(
    getVadSettings(customEffective),
    getVadSettings(effective),
    `${engine} custom conversion preserves VAD execution`,
  );
  assert.equal(customEffective.maxContext, effective.maxContext);
  assert.equal(customEffective.reduceRepetition, effective.reduceRepetition);
  custom.vadThreshold = 0.42;
  assert.equal(
    resolveEffectiveSettings(custom, globalSettings).vadThreshold,
    0.42,
  );
  assert.deepEqual(globalSettings, before);
}
assert.equal(
  resolveEffectiveSettings(
    { subtitleOutcome: 'custom', vadThreshold: 9 },
    { vadThreshold: 0.4 },
  ).vadThreshold,
  0.4,
);
for (const key of TASK_VAD_FIELDS) mockFormValues[key] = 0.2;
mockFormValues.maxContext = 0;
mockFormValues.reduceRepetition = true;
applyScenarioPreset(mockForm, 'balanced');
for (const key of TASK_VAD_FIELDS) assert.equal(mockFormValues[key], undefined);
assert.equal(mockFormValues.maxContext, undefined);
assert.equal(mockFormValues.reduceRepetition, undefined);
assert.equal(mockFormValues.aiCorrection, undefined);
assert.equal(mockFormValues.subtitleFillerPolicy, undefined);
assert.equal(mockFormValues.subtitleTranslationStyle, undefined);

const paused: TokenTriple[] = [
  ['00:00:00,000', '00:00:00,200', 'First'],
  ['00:00:00,600', '00:00:00,800', 'I'],
  ['00:00:01,200', '00:00:01,500', 'agree'],
];
assert.deepEqual(
  composeWordCues(paused, interview.fields),
  paused,
  'fragments are not merged across pauses and ends are not extended',
);
const durationTokens: TokenTriple[] = Array.from({ length: 8 }, (_, i) => [
  `00:00:0${i},000`,
  `00:00:0${i + 1},000`,
  'a',
]);
const short = composeWordCues(durationTokens, {
  subtitleMaxDuration: 3,
  maxSubtitleChars: -1,
  preserveSpeechPauses: true,
});
assert.ok(short.length >= 3);
assert.ok(
  short.every((cue) => parseTime(cue[1])! - parseTime(cue[0])! <= 3),
  'fragment merge must respect maximum duration',
);
const capped = composeWordCues(
  [
    ['00:00:00,000', '00:00:00,200', 'Test'],
    ['00:00:05,000', '00:00:06,000', 'next'],
  ],
  { subtitleMaxDuration: 0.5 },
);
assert.equal(
  capped[0][1],
  '00:00:00,500',
  'readability extension respects explicit maximum duration',
);
const segment: TokenTriple[] = [
  [
    '00:00:00,000',
    '00:00:12,000',
    'A longer sentence with several words and more text.',
  ],
];
const split = resplitSubtitleCues(segment, {
  subtitleMaxDuration: 3,
  maxSubtitleChars: -1,
});
assert.ok(
  split.length > 1,
  'segment-only engines honor duration without width limit',
);
assert.equal(split[0][0], segment[0][0]);
assert.equal(split.at(-1)![1], segment[0][1]);
assert.equal(
  split
    .map((cue) => cue[2])
    .join('')
    .replace(/\s/g, ''),
  segment[0][2].replace(/\s/g, ''),
);
assert.ok(
  split.every((cue) => parseTime(cue[1])! - parseTime(cue[0])! <= 3.001),
);
assert.deepEqual(
  resplitSubtitleCues(segment, {}),
  segment,
  'legacy defaults unchanged',
);

console.log(
  '✓ Scenario mapping, VAD precedence, expert conversion and segmentation tests passed',
);
