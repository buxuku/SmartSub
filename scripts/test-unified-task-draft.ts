import assert from 'assert';
import {
  buildLaunchpadDraft,
  appendLaunchpadFiles,
} from '../renderer/lib/launchpadDraft';
import {
  taskDraftManager,
  TaskDraftManager,
  TASK_WIZARD_DRAFT_KEY,
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

// Test patchDraft preserves existing draft fields
taskDraftManager.saveDraft(draftData);
taskDraftManager.patchDraft({
  files: [{ uuid: '3', filePath: '/media/video3.mp4', fileName: 'video3.mp4' }],
});
const patched = taskDraftManager.getDraft();
assert(patched, 'Patched draft must exist');
assert.strictEqual(patched.files.length, 1);
assert.strictEqual(patched.files[0].fileName, 'video3.mp4');
assert.strictEqual(patched.goals?.translate, true, 'Goals must be preserved');
assert.strictEqual(
  patched.config?.scenarioPreset,
  'lecture',
  'Config must be preserved',
);

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
    pythonEngineStatus: { state: 'ready' },
  },
  providers: [
    {
      id: 'provider-1',
      name: 'Local service',
      type: 'deeplx',
      isAi: false,
      apiUrl: 'http://localhost:1188/translate',
    },
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

for (const invalid of [
  { goals: { translate: 'yes' } },
  { manualPairs: [1] },
  { manualManuscriptPairs: [['only-one-path']] },
  { config: [] },
  { pipeline: { subtitle: 'invalid' } },
  { savedAt: -1 },
  { files: [{ filePath: '', fileName: 'empty' }] },
]) {
  assert.equal(
    taskDraftManager.deserializeDraft(
      JSON.stringify({ ...draftData, ...invalid }),
    ),
    null,
  );
}
const storage = new Map<string, string>();
let storageBlocked = false;
let readBlocked = false;
(globalThis as any).window = {
  localStorage: {
    getItem: (key: string) => {
      if (readBlocked) throw new Error('Test read unavailable');
      return storage.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storageBlocked) throw new Error('Test quota exceeded');
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      if (storageBlocked) throw new Error('Test storage unavailable');
      storage.delete(key);
    },
  },
};
const manager = new TaskDraftManager();
assert.equal(manager.saveDraft(draftData), true);
assert.equal(manager.storageFailed, false);
assert.ok(new TaskDraftManager().getDraft()?.files.length);
const returned = manager.getDraft()!;
returned.files[0].filePath = '/caller-mutated.mp4';
assert.notEqual(
  manager.getDraft()!.files[0].filePath,
  returned.files[0].filePath,
);
const changed = { ...draftData, goals: { translate: false } };
storageBlocked = true;
assert.equal(manager.saveDraft(changed), false);
assert.equal(manager.storageFailed, true);
assert.equal(
  manager.getDraft()?.goals?.translate,
  false,
  'failed durable write retains latest memory draft',
);
assert.equal(
  JSON.parse(storage.get(TASK_WIZARD_DRAFT_KEY)!).goals.translate,
  true,
);
changed.goals.translate = true;
assert.equal(
  manager.getDraft()?.goals?.translate,
  false,
  'caller mutation cannot change memory snapshot',
);
assert.equal(manager.clearDraft(), false);
assert.equal(
  manager.getDraft(),
  null,
  'failed removal must not resurrect old saved draft',
);
storageBlocked = false;
assert.equal(manager.saveDraft(draftData), true);
assert.equal(manager.storageFailed, false);
assert.equal(manager.clearDraft(), true);
assert.equal(storage.has(TASK_WIZARD_DRAFT_KEY), false);
console.log(
  'Task draft schema, isolated snapshot, disk recovery, quota failure, memory fallback and failed removal tests passed.',
);

storage.set(TASK_WIZARD_DRAFT_KEY, 'unreadable-draft');
const corruptManager = new TaskDraftManager();
assert.equal(corruptManager.getDraft(), null);
assert.equal(corruptManager.storageFailed, true);
assert.equal(
  corruptManager.saveDraft({ files: [], savedAt: Date.now() }),
  false,
);
assert.equal(corruptManager.saveDraft(draftData), false);
assert.equal(storage.get(TASK_WIZARD_DRAFT_KEY), 'unreadable-draft');
assert.equal(corruptManager.clearDraft(), true, 'explicit discard is allowed');
assert.equal(corruptManager.saveDraft(draftData), true);
readBlocked = true;
const unreadManager = new TaskDraftManager();
assert.equal(unreadManager.getDraft(), null);
assert.equal(
  unreadManager.saveDraft({ files: [], savedAt: Date.now() }),
  false,
);
assert.equal(storage.has(TASK_WIZARD_DRAFT_KEY), true);
readBlocked = false;
assert.equal(unreadManager.getDraft()?.files.length, 2);
assert.equal(unreadManager.storageFailed, false);

const launchDraft = buildLaunchpadDraft(sampleFiles, baseConfig, {
  id: 'custom-recipe',
  name: 'Full pipeline',
  accepts: 'media',
  goals: { translate: true, dub: true, video: true },
  config: {
    sourceLanguage: 'ja',
    targetLanguage: 'en',
    gates: { subtitle: 'auto', dubbing: 'manual' },
    dub: {
      engine: { kind: 'cloud', providerId: 'tts' },
      voice: 'alloy',
      language: 'en',
      globalSpeed: 1.25,
    },
    compose: { subtitle: 'soft' },
  },
});
assert.ok(launchDraft.id);
assert.equal(launchDraft.config?.sourceLanguage, 'ja');
assert.equal(launchDraft.pipeline?.dubbing.engineKey, 'cloud:tts');
assert.equal(launchDraft.pipeline?.dubbing.globalSpeed, 1.25);
assert.equal(launchDraft.pipeline?.subtitle, 'soft');
assert.equal(launchDraft.pipeline?.subtitleGate, false);
assert.equal(launchDraft.pipeline?.dubbingGate, true);
assert.equal(launchDraft.pipeline?.recipeName, 'Full pipeline');
assert.ok(manager.deserializeDraft(JSON.stringify(launchDraft)));
const appended = appendLaunchpadFiles(launchDraft, [
  ...sampleFiles,
  { filePath: '/new.mp4', fileName: 'new' },
]);
assert.equal(appended.files.length, 3);
assert.equal(appended.id, launchDraft.id);
assert.deepEqual(appended.pipeline, launchDraft.pipeline);
appended.config!.sourceLanguage = 'zh';
assert.equal(launchDraft.config?.sourceLanguage, 'ja');
console.log(
  'Corrupt/unreadable draft preservation and complete launchpad recipe handoff passed.',
);
