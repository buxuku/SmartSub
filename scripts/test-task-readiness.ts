import assert from 'node:assert/strict';
import {
  validateTaskConfigReady,
  validateTaskStart,
  type TaskReadinessInput,
} from '../renderer/lib/taskReadiness';
import { TASK_TYPES } from '../renderer/lib/taskTypes';
import { buildTaskSnapshotFromConfig } from '../renderer/hooks/useUnifiedTaskConfig';

async function main() {
  const base: TaskReadinessInput = {
    files: [{ filePath: '/video.mp4' }],
    typeDef: TASK_TYPES[0],
    formData: {
      transcriptionEngine: 'builtin',
      model: 'base',
      targetLanguage: 'zh',
      translateProvider: 'translation',
    },
    systemInfo: { modelsInstalled: ['base'] },
    providers: [
      {
        id: 'translation',
        name: 'Local',
        type: 'deeplx',
        isAi: false,
        apiUrl: 'http://localhost:1188/translate',
      },
    ],
  };
  const check = (patch: Partial<TaskReadinessInput>, error?: string) => {
    const result = validateTaskConfigReady({ ...base, ...patch });
    if (error)
      assert.ok(
        result.errors.includes(error),
        `${error}: ${JSON.stringify(result)}`,
      );
    else assert.equal(result.valid, true, JSON.stringify(result));
    return result;
  };
  check({});
  check(
    {
      formData: {
        ...base.formData,
        subtitleTranslationStyle: 'conversational',
      },
    },
    'translation_style_requires_ai',
  );
  check({
    formData: { ...base.formData, subtitleTranslationStyle: 'neutral' },
  });
  check({
    formData: { ...base.formData, subtitleTranslationStyle: 'conversational' },
    translateOn: false,
  });
  check({
    formData: { ...base.formData, subtitleTranslationStyle: 'conversational' },
    providers: [
      {
        id: 'translation',
        name: 'AI',
        type: 'openai',
        isAi: true,
        apiUrl: 'http://localhost:1234/v1',
        apiKey: 'test-only',
        modelName: 'fixture',
      },
    ],
  });
  const withSpeakers = { ...base.formData, speakerDiarization: true };
  check({ formData: withSpeakers }, 'speaker_diarization_unavailable');
  check(
    {
      formData: withSpeakers,
      systemInfo: {
        ...base.systemInfo,
        speakerDiarizationModelInstalled: true,
      },
    },
    'speaker_diarization_unavailable',
  );
  check({
    formData: withSpeakers,
    systemInfo: {
      ...base.systemInfo,
      speakerDiarizationModelInstalled: true,
      speakerDiarizationRuntimeInstalled: true,
    },
  });
  check(
    {
      formData: withSpeakers,
      files: [{ filePath: '/video.mp4', providedSubtitlePath: '/paired.srt' }],
    },
    'speaker_diarization_unavailable',
  );
  check({
    formData: withSpeakers,
    files: [{ filePath: '/input.srt' }],
    typeDef: TASK_TYPES[2],
    systemInfo: {},
  });
  check({ systemInfo: { modelsInstalled: ['tiny'] } }, 'model_unavailable');
  check({ files: [] }, 'files_required');
  check({ typeDef: TASK_TYPES[2] }, 'subtitle_files_required');
  check({ formData: { ...base.formData, model: '' } }, 'model_required');
  check(
    { formData: { ...base.formData, targetLanguage: 'auto' } },
    'target_language_required',
  );
  check({ providers: [] }, 'provider_required');
  check(
    { providers: [{ ...base.providers![0], apiUrl: '' }] },
    'provider_required',
  );
  check(
    { formData: { ...base.formData, aiCorrection: true } },
    'refine_provider_required',
  );
  check({
    files: [{ filePath: '/video.mp4', providedSubtitlePath: '/paired.srt' }],
    systemInfo: {},
    formData: { ...base.formData, model: '', aiCorrection: true },
  });
  check({
    files: [{ filePath: '/input.srt' }],
    typeDef: TASK_TYPES[2],
    systemInfo: {},
  });
  check({
    files: [{ filePath: '/input.srt' }],
    typeDef: TASK_TYPES[2],
    formData: { dub: {}, translateProvider: '-1' },
    providers: [],
    systemInfo: {},
  });
  check(
    {
      formData: { ...base.formData, transcriptionEngine: 'fasterWhisper' },
      systemInfo: {
        fasterWhisperModelsInstalled: ['base'],
        pythonEngineStatus: { state: 'not_installed' },
      },
    },
    'model_unavailable',
  );
  check({
    formData: { ...base.formData, transcriptionEngine: 'fasterWhisper' },
    systemInfo: {
      fasterWhisperModelsInstalled: ['base'],
      pythonEngineStatus: { state: 'ready' },
    },
  });
  for (const [engine, model, list, vad] of [
    [
      'funasr',
      'sensevoice-small',
      'funasrAsrModelsInstalled',
      'funasrVadInstalled',
    ],
    ['qwen', 'qwen3-asr-0.6b', 'qwenModelsInstalled', 'qwenVadInstalled'],
    [
      'fireRedAsr',
      'fire-red-asr-large-zh-en',
      'fireRedModelsInstalled',
      'fireRedVadInstalled',
    ],
    [
      'parakeet',
      'parakeet-tdt-0.6b-v3',
      'parakeetModelsInstalled',
      'parakeetVadInstalled',
    ],
  ]) {
    const formData = { ...base.formData, transcriptionEngine: engine, model };
    check({ formData, systemInfo: { [list]: [model], [vad]: true } });
    check(
      { formData, systemInfo: { [list]: [model], [vad]: false } },
      'model_unavailable',
    );
  }
  check(
    {
      formData: { ...base.formData, transcriptionEngine: 'localCli' },
      includeLocalCli: true,
    },
    'local_command_required',
  );
  check({
    formData: { ...base.formData, transcriptionEngine: 'localCli' },
    includeLocalCli: true,
    whisperCommand: 'whisper command',
  });
  check(
    {
      formData: {
        ...base.formData,
        transcriptionEngine: 'cloud',
        asrProviderId: 'gone',
      },
    },
    'model_unavailable',
  );

  const existing = new Set(['/video.mp4', '/paired.srt', '/cached.srt']);
  let info = base.systemInfo;
  let ttsProviders: any[] = [
    { id: 'tts', type: 'edge', name: 'Test voice', voices: 'en-US-AriaNeural' },
  ];
  const calls: string[] = [];
  (globalThis as any).window = {
    ipc: {
      invoke: async (channel: string, payload?: any) => {
        calls.push(channel);
        if (channel === 'getSystemInfo') return info;
        if (channel === 'getTranslationProviders') return base.providers;
        if (channel === 'getAsrProviders') return [];
        if (channel === 'getSettings') return {};
        if (channel === 'getTtsProviders') return ttsProviders;
        if (channel === 'getTtsModelStatus') return { models: [] };
        if (channel === 'voiceClone:list') return { success: true, data: [] };
        if (channel === 'checkFileExists')
          return { exists: existing.has(payload.filePath) };
        throw new Error(channel);
      },
    },
  };
  assert.equal((await validateTaskStart(base)).valid, true);
  info = {};
  assert.ok(
    (await validateTaskStart(base)).errors.includes('model_unavailable'),
    'new start refreshes removed model state',
  );
  const paired = {
    ...base,
    files: [{ filePath: '/video.mp4', providedSubtitlePath: '/paired.srt' }],
  };
  assert.equal((await validateTaskStart(paired)).valid, true);
  existing.delete('/paired.srt');
  assert.ok(
    (await validateTaskStart(paired)).errors.includes(
      'paired_subtitle_unavailable',
    ),
  );
  const resumed = {
    ...base,
    formData: { ...base.formData, compose: {} },
    files: [
      {
        filePath: '/video.mp4',
        extractSubtitle: 'done',
        srtFile: '/cached.srt',
        embeddedSubtitle: true,
      },
    ],
  };
  assert.equal((await validateTaskStart(resumed)).valid, true);
  existing.add('/roles.json');
  const resumedSpeakers = {
    ...resumed,
    formData: { ...resumed.formData, speakerDiarization: true },
    files: resumed.files.map((file) => ({
      ...file,
      speakerDiarization: 'done',
      proofreadDataReady: 'done',
      exportSubtitle: 'done',
      proofreadDataFile: '/roles.json',
    })),
  };
  assert.equal(
    (await validateTaskStart(resumedSpeakers)).valid,
    true,
    'completed downstream retry does not require removed model',
  );
  existing.delete('/roles.json');
  assert.ok(
    validateTaskConfigReady({
      ...base,
      ...resumedSpeakers,
      formData: { ...resumedSpeakers.formData, useEmbeddedSubtitles: false },
    }).errors.includes('speaker_diarization_unavailable'),
    'forcing fresh ASR invalidates the old speaker analysis exemption',
  );
  assert.ok(
    (await validateTaskStart(resumedSpeakers)).errors.includes(
      'speaker_diarization_unavailable',
    ),
    'missing sidecar requires analysis dependencies again',
  );
  assert.ok(
    (
      await validateTaskStart({
        ...resumed,
        formData: { ...resumed.formData, useEmbeddedSubtitles: false },
      })
    ).errors.includes('model_unavailable'),
  );
  existing.delete('/video.mp4');
  assert.ok(
    (await validateTaskStart(base)).errors.includes('input_unavailable'),
  );
  assert.equal(
    calls.filter((channel) => channel === 'getSystemInfo').length,
    9,
  );
  const source = { nested: { value: 1 }, array: ['original'] };
  existing.add('/paired.srt');
  existing.add('/video.mp4');
  const dubbing = {
    ...paired,
    formData: {
      ...base.formData,
      dub: {
        engine: { kind: 'cloud', providerId: 'tts' },
        voice: 'en-US-AriaNeural',
      },
    },
  };
  assert.equal((await validateTaskStart(dubbing)).valid, true);
  ttsProviders[0].voices = 'en-US-GuyNeural';
  assert.ok(
    (await validateTaskStart(dubbing)).errors.includes('tts_voice_unavailable'),
  );
  ttsProviders = [];
  assert.ok(
    (await validateTaskStart(dubbing)).errors.includes('tts_unavailable'),
  );
  const snapshot = buildTaskSnapshotFromConfig(source);
  source.nested.value = 2;
  source.array.push('changed');
  assert.equal(snapshot.nested.value, 1);
  assert.deepEqual(snapshot.array, ['original']);
  console.log(
    'Task readiness: selected engines and runtimes, provider configuration, paired inputs, fresh start/retry dependencies and snapshot isolation passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
