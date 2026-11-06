import assert from 'assert';
import {
  ALL_PRESET_FIELD_KEYS,
  SCENARIO_PRESETS,
  applyScenarioPreset,
  detectCurrentPreset,
  getBaseScenarioPreset,
  getPresetDeviations,
  getScenarioPresetDef,
  getScenarioState,
  groupPresetDeviations,
  isExpertPageGroup,
  convertToCustomOutcome,
  leaveCustomOutcome,
  type ScenarioPresetId,
} from '../renderer/lib/scenarioPresets';
import {
  resolveEffectiveSettings,
  supportsOutcomeStrategy,
  supportsTaskVadField,
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

// 3b. What counts as "changed". A fresh install carries maxSubtitleChars: 0 and
// speakerDiarizationCount: 0 (both mean "let SmartSub decide"); reading those zeros as
// changes made every new user start on "专家自定义".
{
  const fresh: Record<string, any> = {
    subtitleOutcome: 'balanced',
    maxSubtitleChars: 0,
    removeChinesePunctuation: false,
    speakerDiarization: false,
    speakerDiarizationCount: 0,
    speakerDiarizationEmbedInSubtitle: false,
  };
  assert.deepEqual(getPresetDeviations(fresh), []);
  assert.strictEqual(detectCurrentPreset(fresh), 'balanced');
  const freshState = getScenarioState(fresh);
  assert.strictEqual(freshState.presetId, 'balanced');
  assert.strictEqual(freshState.adjusted, false);
  assert.strictEqual(freshState.expertAdjusted, false);
  assert.strictEqual(getBaseScenarioPreset(undefined), 'balanced');
  assert.strictEqual(getBaseScenarioPreset({}), 'balanced');
  assert.deepEqual(getPresetDeviations(undefined), []);

  // The zero is only "untouched" for those two fields; a real value, or a zero anywhere
  // else, is a change.
  for (const maxSubtitleChars of [28, 40, -1]) {
    assert.deepEqual(
      getPresetDeviations({ ...fresh, maxSubtitleChars }),
      ['maxSubtitleChars'],
      `maxSubtitleChars: ${maxSubtitleChars} is a real value`,
    );
  }
  assert.deepEqual(
    getPresetDeviations({ ...fresh, speakerDiarizationCount: 2 }),
    ['speakerDiarizationCount'],
  );
  for (const key of [
    'fasterWhisperTemperature',
    'subtitleMaxGap',
    'subtitleMaxDuration',
    'subtitleLineWidth',
    'vadMaxSpeechDuration',
  ]) {
    assert.deepEqual(
      getPresetDeviations({ ...fresh, [key]: 0 }),
      [key],
      `${key}: 0 is a real value`,
    );
  }
  for (const untouched of [undefined, null, '', false]) {
    assert.deepEqual(
      getPresetDeviations({ ...fresh, subtitleMaxGap: untouched }),
      [],
      `${String(untouched)} is untouched`,
    );
  }

  // A snapshot saved before the tiers existed has no subtitleOutcome; it reads as the
  // tier its knobs add up to instead of being compared as `undefined`.
  const legacy: Record<string, any> = { ...fresh };
  delete legacy.subtitleOutcome;
  assert.deepEqual(getPresetDeviations(legacy), []);
  assert.deepEqual(
    getPresetDeviations({ ...legacy, useVAD: false }),
    ['subtitleOutcome'],
    'VAD switched off is a hand-tuned snapshot, which reads as the 手动调节 tier',
  );
  assert.deepEqual(
    getPresetDeviations({ ...legacy, maxContext: 0, reduceRepetition: true }),
    ['subtitleOutcome', 'maxContext', 'reduceRepetition'],
    'context 0 + anti-repetition reads as the 最干净最稳 tier, which is not 通用均衡',
  );
  assert.strictEqual(getScenarioState(legacy).adjusted, false);

  // Every scenario applied on top of the fresh defaults is exactly that scenario.
  for (const preset of SCENARIO_PRESETS.filter((p) => p.id !== 'custom')) {
    const values: Record<string, any> = { ...fresh };
    applyScenarioPreset(
      {
        setValue: (key, value) => {
          values[key] = value;
        },
        resetField: (key) => {
          delete values[key];
        },
      },
      preset.id,
    );
    assert.deepEqual(getPresetDeviations(values), [], preset.id);
    assert.strictEqual(detectCurrentPreset(values), preset.id, preset.id);
    assert.strictEqual(getScenarioState(values).adjusted, false, preset.id);
  }

  // The button keeps the scenario's name and reports what moved, in the groups a person
  // recognises and where each lives.
  const lectureValues: Record<string, any> = {
    scenarioPreset: 'lecture',
    ...lecture.fields,
  };
  assert.strictEqual(getScenarioState(lectureValues).adjusted, false);
  const tweakedBeam = getScenarioState({
    ...lectureValues,
    fasterWhisperBeamSize: 1,
    fasterWhisperTemperature: 0.4,
  });
  assert.strictEqual(tweakedBeam.presetId, 'lecture');
  assert.deepEqual(tweakedBeam.deviations, [
    'fasterWhisperBeamSize',
    'fasterWhisperTemperature',
  ]);
  assert.deepEqual(tweakedBeam.groups, ['decoding'], 'two keys, one group');
  assert.strictEqual(tweakedBeam.expertAdjusted, true);
  const noCorrection = getScenarioState({
    ...lectureValues,
    aiCorrection: false,
    subtitleFillerPolicy: 'preserve',
    maxSubtitleChars: 20,
  });
  assert.deepEqual(noCorrection.groups, [
    'segmentLength',
    'aiCorrection',
    'fillerPolicy',
  ]);
  assert.strictEqual(
    noCorrection.expertAdjusted,
    false,
    'none of these live on the 专家 page',
  );
  assert.deepEqual(
    groupPresetDeviations(['subtitleOutcome', 'vadThreshold', 'maxContext']),
    ['recognitionStrategy', 'vadRepetition'],
  );
  assert.deepEqual(groupPresetDeviations(['unknownKey']), []);
  // A different scenario to compare against: the interview values are far from 通用均衡.
  assert.ok(
    getPresetDeviations(interviewValues, 'balanced').includes(
      'speakerDiarization',
    ),
  );
  // 自定义 has nothing to compare against, and an id this version dropped reads as 自定义.
  for (const scenarioPreset of ['custom', 'retired-scenario']) {
    const state = getScenarioState({ ...fresh, scenarioPreset });
    assert.strictEqual(state.presetId, 'custom', scenarioPreset);
    assert.deepEqual(state.deviations, [], scenarioPreset);
    assert.strictEqual(state.adjusted, false, scenarioPreset);
    assert.strictEqual(
      detectCurrentPreset({ ...fresh, scenarioPreset }),
      'custom',
      scenarioPreset,
    );
  }
  // Every key a preset can touch is owned by exactly one group.
  assert.strictEqual(
    groupPresetDeviations(ALL_PRESET_FIELD_KEYS as string[]).length,
    10,
    'ten groups cover every preset field',
  );
  assert.strictEqual(
    (ALL_PRESET_FIELD_KEYS as string[]).every(
      (key) => groupPresetDeviations([key]).length === 1,
    ),
    true,
    'no preset field is left out of the groups',
  );
  // Only the expert-page groups light the 专家 tab.
  assert.deepEqual(
    (
      [
        'recognitionStrategy',
        'decoding',
        'vadRepetition',
        'segmentLength',
        'segmentTuning',
        'speakerDiarization',
        'aiCorrection',
        'fillerPolicy',
        'translationStyle',
        'subtitleLayout',
      ] as const
    ).filter(isExpertPageGroup),
    ['recognitionStrategy', 'decoding', 'vadRepetition', 'segmentTuning'],
  );

  // Which engines read the recognition strategy at all.
  for (const engine of [
    undefined,
    'builtin',
    'fasterWhisper',
    'funasr',
    'qwen',
    'fireRedAsr',
    'parakeet',
  ]) {
    assert.strictEqual(supportsOutcomeStrategy(engine), true, String(engine));
  }
  for (const engine of ['cloud', 'localCli']) {
    assert.strictEqual(supportsOutcomeStrategy(engine), false, engine);
    assert.strictEqual(supportsTaskVadField(engine, 'vadThreshold'), false);
  }
}

// Verify effective values, not only labels or serialized form fields.
// The faster-whisper accurate preset must survive conversion to custom without
// leaking into global settings or the next balanced task.
{
  const globalSettings = Object.freeze({
    vadThreshold: 0.5,
    vadMinSpeechDuration: 250,
    vadMinSilenceDuration: 180,
    vadSpeechPad: 320,
  });
  const accurate = Object.freeze({
    transcriptionEngine: 'fasterWhisper',
    subtitleOutcome: 'accurate',
  });
  const effective = resolveEffectiveSettings(accurate, globalSettings);
  assert.equal(effective.useVAD, true);
  assert.equal(effective.vadThreshold, 0.35);
  assert.equal(effective.vadMinSpeechDuration, 100);
  assert.equal(effective.vadMinSilenceDuration, 180);
  assert.equal(effective.vadSpeechPad, 320);
  const custom: Record<string, unknown> = { ...accurate };
  convertToCustomOutcome(
    {
      setValue: (key, value) => {
        custom[key] = value;
      },
    },
    accurate,
    globalSettings,
  );
  assert.equal(custom.subtitleOutcome, 'custom');
  assert.deepEqual(resolveEffectiveSettings(custom, globalSettings), effective);
  const overrides = resolveEffectiveSettings(
    { ...accurate, vadThreshold: 0.6, vadMinSpeechDuration: 180 },
    globalSettings,
  );
  assert.equal(overrides.vadThreshold, 0.6);
  assert.equal(overrides.vadMinSpeechDuration, 180);
  const invalid = resolveEffectiveSettings(
    { ...accurate, vadThreshold: NaN, vadMinSpeechDuration: -1 },
    globalSettings,
  );
  assert.equal(invalid.vadThreshold, 0.35);
  assert.equal(invalid.vadMinSpeechDuration, 100);
  for (const subtitleOutcome of ['balanced', 'clean', 'custom', undefined]) {
    const settings = resolveEffectiveSettings(
      { ...accurate, subtitleOutcome },
      globalSettings,
    );
    assert.equal(settings.vadThreshold, 0.5);
    assert.equal(settings.vadMinSpeechDuration, 250);
  }
  for (const transcriptionEngine of ['builtin', 'localCli']) {
    const settings = resolveEffectiveSettings(
      { ...accurate, transcriptionEngine },
      globalSettings,
    );
    assert.equal(settings.vadThreshold, 0.5);
    assert.equal(settings.vadMinSpeechDuration, 250);
  }
}

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

// Leaving 手动调节 for a built-in tier hands the task back to that tier. 手动调节 writes the
// effective VAD / context / repetition values of the tier it replaces into the task, and
// `withTaskVad` applies task-level VAD values under every tier, so values left behind would make
// 最干净最稳 run with the VAD of whichever tier (or slider position) the user came from.
{
  const globalSettings = {
    vadThreshold: 0.5,
    vadMinSpeechDuration: 250,
    vadMinSilenceDuration: 180,
    vadSpeechPad: 320,
  };
  const tiers = ['accurate', 'balanced', 'clean'] as const;
  const manualKnobs = [
    'maxContext',
    'useVAD',
    'reduceRepetition',
    ...TASK_VAD_FIELDS,
  ];
  for (const transcriptionEngine of [
    'builtin',
    'fasterWhisper',
    'funasr',
    'qwen',
    'fireRedAsr',
    'parakeet',
  ]) {
    for (const from of tiers) {
      for (const to of tiers) {
        const label = `${transcriptionEngine}: ${from} → 手动调节 → ${to}`;
        const values: Record<string, unknown> = {
          transcriptionEngine,
          subtitleOutcome: from,
          fasterWhisperBeamSize: 5,
        };
        const form = {
          setValue: (key: string, value: unknown) => {
            values[key] = value;
          },
        };
        convertToCustomOutcome(form, values, globalSettings);
        // On 手动调节 the user may also move a slider.
        values.vadThreshold = 0.2;
        values.vadMinSpeechDuration = 600;
        leaveCustomOutcome(form, to);
        assert.equal(values.subtitleOutcome, to, label);
        assert.deepEqual(
          resolveEffectiveSettings(values, globalSettings),
          resolveEffectiveSettings(
            { transcriptionEngine, subtitleOutcome: to },
            globalSettings,
          ),
          `${label} runs like a task that was on ${to} all along`,
        );
        for (const key of manualKnobs)
          assert.equal(values[key], undefined, `${label}: ${key} is dropped`);
        assert.equal(
          values.fasterWhisperBeamSize,
          5,
          'nothing else is touched',
        );
        assert.equal(
          values.scenarioPreset,
          'custom',
          'the scenario label stays 自定义 (one-way by design)',
        );
      }
    }
  }
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
