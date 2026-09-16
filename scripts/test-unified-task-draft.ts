import assert from 'assert';
import {
  taskDraftManager,
  type TaskDraft,
} from '../renderer/lib/taskDraftManager';
import {
  buildTaskSnapshotFromConfig,
  validateTaskConfigReady,
} from '../renderer/hooks/useUnifiedTaskConfig';

console.log('=== Running Unified Task Draft & State Machine Tests ===');

// 1. Test draft serialization & deserialization
const sampleFiles = [
  { filePath: '/media/video1.mp4', fileName: 'video1.mp4' },
  { filePath: '/media/video2.mp4', fileName: 'video2.mp4' },
];

const draftData: TaskDraft = {
  files: sampleFiles,
  goals: {
    translate: true,
    dub: false,
    video: true,
  },
  manualPairs: [['/media/video1.mp4', '/media/video1.srt']],
  manualManuscriptPairs: [['/media/video2.mp4', '/media/video2.txt']],
  taskType: 'generate-translate',
  config: {
    transcriptionEngine: 'fasterWhisper',
    model: 'base',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    scenarioPreset: 'lecture',
  },
  savedAt: Date.now(),
};

const serialized = taskDraftManager.serializeDraft(draftData);
assert(typeof serialized === 'string', 'Serialized draft must be string');

const deserialized = taskDraftManager.deserializeDraft(serialized);
assert(deserialized, 'Deserialized draft must not be null');
assert.strictEqual(deserialized.files.length, 2);
assert.strictEqual(deserialized.goals?.translate, true);
assert.strictEqual(deserialized.goals?.video, true);
assert.strictEqual(deserialized.goals?.dub, false);
assert.strictEqual(deserialized.manualPairs?.[0]?.[1], '/media/video1.srt');
assert.strictEqual(
  deserialized.manualManuscriptPairs?.[0]?.[1],
  '/media/video2.txt',
);
assert.strictEqual(deserialized.config?.scenarioPreset, 'lecture');

// Test corrupted json recovery
const corrupted = taskDraftManager.deserializeDraft('invalid-json{{{');
assert.strictEqual(corrupted, null, 'Corrupted draft must return null');

// 2. Test buildTaskSnapshotFromConfig
const baseConfig = {
  transcriptionEngine: 'fasterWhisper',
  model: 'base',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  translateProvider: 'provider-1',
  scenarioPreset: 'interview',
  subtitleOutcome: 'clean',
  fasterWhisperBeamSize: 5,
};

const snapshot = buildTaskSnapshotFromConfig(baseConfig, {
  goals: { translate: true, dub: true, video: false },
  gates: { subtitle: 'manual', dubbing: 'auto' },
  recipeName: 'Interview Workflow',
});

assert.strictEqual(snapshot.transcriptionEngine, 'fasterWhisper');
assert.strictEqual(snapshot.scenarioPreset, 'interview');
assert.strictEqual(snapshot.subtitleOutcome, 'clean');
assert.strictEqual(snapshot.recipeName, 'Interview Workflow');
assert.strictEqual(snapshot.gates?.subtitle, 'manual');
assert.strictEqual(snapshot.gates?.dubbing, 'auto');

// 3. Test validateTaskConfigReady
const validTypeDef: any = {
  taskType: 'generate-translate',
  needsModel: true,
  hasTranslate: true,
  accepts: 'media',
};

const readyResult = validateTaskConfigReady({
  files: sampleFiles,
  typeDef: validTypeDef,
  formData: {
    transcriptionEngine: 'fasterWhisper',
    model: 'base',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    translateProvider: 'provider-1',
  },
  systemInfo: {
    fasterWhisperModelsInstalled: ['base'],
  },
  providers: [
    { id: 'provider-1', name: 'OpenAI', isAi: true, isConfigured: true },
  ],
});

assert.strictEqual(
  readyResult.valid,
  true,
  'Fully configured task should be valid',
);
assert.strictEqual(readyResult.errors.length, 0);

// Missing files
const noFilesResult = validateTaskConfigReady({
  files: [],
  typeDef: validTypeDef,
  formData: baseConfig,
  systemInfo: {},
  providers: [],
});
assert.strictEqual(noFilesResult.valid, false);
assert(noFilesResult.errors.some((e) => e.includes('files')));

// Missing model
const noModelResult = validateTaskConfigReady({
  files: sampleFiles,
  typeDef: validTypeDef,
  formData: { ...baseConfig, model: '' },
  systemInfo: {},
  providers: [],
});
assert.strictEqual(noModelResult.valid, false);
assert(noModelResult.errors.some((e) => e.includes('model')));

console.log(
  '✓ All Unified Task Draft & State Machine tests passed successfully!',
);
