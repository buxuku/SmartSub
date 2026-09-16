import assert from 'assert';
import {
  SCENARIO_PRESETS,
  applyScenarioPreset,
  detectCurrentPreset,
  getScenarioPresetDef,
  type ScenarioPresetId,
} from '../renderer/lib/scenarioPresets';

console.log('=== Running Scenario Presets Tests ===');

// 1. Verify preset definitions
assert(Array.isArray(SCENARIO_PRESETS), 'SCENARIO_PRESETS must be an array');
assert.strictEqual(
  SCENARIO_PRESETS.length,
  5,
  'Must contain 5 presets (4 built-in + custom)',
);

const presetIds = SCENARIO_PRESETS.map((p) => p.id);
assert(presetIds.includes('interview'), 'Must contain interview preset');
assert(presetIds.includes('lecture'), 'Must contain lecture preset');
assert(presetIds.includes('movie'), 'Must contain movie preset');
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
assert.strictEqual(lecture.fields.subtitleOutcome, 'accurate');
assert.strictEqual(lecture.fields.fasterWhisperBeamSize, 5);
assert.strictEqual(lecture.fields.fasterWhisperTemperature, 0);
assert.strictEqual(lecture.fields.fasterWhisperCompressionRatioThreshold, 2.2);
assert.strictEqual(lecture.fields.fasterWhisperLogProbThreshold, -0.8);

const movie = getScenarioPresetDef('movie');
assert(movie, 'movie preset def must exist');
assert.strictEqual(movie.fields.subtitleOutcome, 'balanced');
assert.strictEqual(movie.fields.fasterWhisperBeamSize, 3);
assert.strictEqual(movie.fields.fasterWhisperTemperature, 0.2);

const balanced = getScenarioPresetDef('balanced');
assert(balanced, 'balanced preset def must exist');
assert.strictEqual(balanced.fields.subtitleOutcome, 'balanced');

// 2. Test applyScenarioPreset
const mockFormValues: Record<string, any> = {};
const mockForm = {
  setValue: (key: string, value: any) => {
    mockFormValues[key] = value;
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
assert.strictEqual(mockFormValues.subtitleOutcome, 'accurate');
assert.strictEqual(mockFormValues.fasterWhisperCompressionRatioThreshold, 2.2);
assert.strictEqual(mockFormValues.fasterWhisperLogProbThreshold, -0.8);
assert.strictEqual(mockFormValues.useVAD, false);
assert.strictEqual(mockFormValues.vadThreshold, undefined);

// 3. Test detectCurrentPreset
assert.strictEqual(detectCurrentPreset(mockFormValues), 'lecture');

// Verify boolean false on unconstrained fields does not trigger custom
const lectureWithFalseVAD = { ...mockFormValues, useVAD: false };
assert.strictEqual(
  detectCurrentPreset(lectureWithFalseVAD),
  'lecture',
  'useVAD: false should not turn lecture into custom',
);

// Tamper with one field: change temperature
const tamperedFormValues = { ...mockFormValues, fasterWhisperTemperature: 0.8 };
assert.strictEqual(detectCurrentPreset(tamperedFormValues), 'custom');

// Test interview detection
const interviewValues: Record<string, any> = {
  scenarioPreset: 'interview',
  subtitleOutcome: 'clean',
  fasterWhisperBeamSize: 5,
  fasterWhisperTemperature: 0,
  useVAD: true,
  vadThreshold: 0.35,
};
assert.strictEqual(detectCurrentPreset(interviewValues), 'interview');

// Tamper with interview: change beam size
assert.strictEqual(
  detectCurrentPreset({ ...interviewValues, fasterWhisperBeamSize: 10 }),
  'custom',
);

console.log('✓ All Scenario Presets tests passed successfully!');
