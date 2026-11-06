const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'smartsub-speaker-settings-'),
);
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
let requests = 0;
let failNext = false;
let cancelNext = false;
const source = path.join(root, 'sine.wav');
execFileSync(ffmpeg, [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000:duration=3',
  '-c:a',
  'pcm_s16le',
  source,
]);
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => root } };
  if (request.endsWith('/storeManager')) return { logMessage() {} };
  if (request.endsWith('/fileUtils')) return { ensureTempDir: () => root };
  if (request.endsWith('/compose/composeQueue')) return {};
  if (request.endsWith('/ttsProviderManager'))
    return { getTtsProviderById: () => ({ id: 'test', type: 'edge' }) };
  if (request.endsWith('/service/tts'))
    return {
      synthesizeSegment: async (_provider, req) => {
        requests++;
        if (failNext) {
          failNext = false;
          fs.copyFileSync(source, req.outWavPath);
          throw new Error('injected synthesis failure');
        }
        fs.copyFileSync(source, req.outWavPath);
        if (cancelNext) {
          cancelNext = false;
          throw new (require('../../main/helpers/taskContext.ts').TaskCancelledError)();
        }
        return { durationMs: 3000 };
      },
    };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const audio = require('../../main/helpers/dubbing/audioPipeline.ts');
  const proc = require('../../main/helpers/dubbing/dubbingProcessor.ts');
  const store = require('../../main/helpers/dubbing/sessionStore.ts');
  const types = require('../../types/dubbing.ts');
  const identity = require('../../main/helpers/dubbing/synthesisIdentity.ts');
  store.setDubbingSessionsRoot(path.join(root, 'sessions'));
  const frequency = (file) => {
    const info = audio.readWavInfo(file),
      bytes = fs.readFileSync(file);
    let crossings = 0;
    const start = Math.round(info.sampleRate * 0.2),
      end = Math.round(info.sampleRate * (info.durationMs / 1000 - 0.2));
    for (let i = start + 1; i < end; i++) {
      if (
        bytes.readInt16LE(info.dataOffset + (i - 1) * 2) <= 0 &&
        bytes.readInt16LE(info.dataOffset + i * 2) > 0
      )
        crossings++;
    }
    return (crossings * info.sampleRate) / (end - start);
  };
  for (const settings of [
    { speed: 1.5, pitch: 0 },
    { speed: 1, pitch: 12 },
    { speed: 0.75, pitch: -12 },
    { speed: 1.25, pitch: 3 },
  ]) {
    const file = path.join(
      root,
      `rate-${settings.speed}-pitch-${settings.pitch}.wav`,
    );
    await audio.applySpeakerSettingsWav(source, file, settings);
    const info = audio.readWavInfo(file);
    assert.equal(info.sampleRate, 24000);
    assert.ok(
      Math.abs(info.durationMs - 3000 / settings.speed) < 90,
      `duration ${JSON.stringify(settings)}: ${info.durationMs}`,
    );
    assert.ok(
      Math.abs(frequency(file) - 440 * 2 ** (settings.pitch / 12)) < 4,
      `pitch ${JSON.stringify(settings)}: ${frequency(file)}`,
    );
  }
  for (const settings of [
    { speed: 0, pitch: 0 },
    { speed: 1, pitch: NaN },
    { speed: 2.1, pitch: 0 },
    { speed: 1, pitch: 13 },
  ]) {
    await assert.rejects(
      audio.applySpeakerSettingsWav(
        source,
        path.join(root, 'invalid.wav'),
        settings,
      ),
      /Invalid speaker/,
    );
  }
  const config = {
    engine: { kind: 'cloud', providerId: 'test' },
    voice: 'en-US-AriaNeural',
    globalSpeed: 1,
    background: 'mute',
    output: 'audioOnly',
  };
  const key = identity.dubbingInputKey(config, config.voice, 'Hello', 'en');
  assert.equal(
    key,
    identity.dubbingInputKey(config, config.voice, 'Hello', 'en', {
      speed: 1,
      pitch: 0,
    }),
  );
  assert.notEqual(
    key,
    identity.dubbingInputKey(config, config.voice, 'Hello', 'en', {
      speed: 1.2,
      pitch: 0,
    }),
  );
  const subtitle = path.join(root, 'input.srt');
  fs.writeFileSync(
    subtitle,
    '1\n00:00:00,000 --> 00:00:10,000\nFirst\n\n2\n00:00:10,000 --> 00:00:20,000\nSecond\n\n3\n00:00:20,000 --> 00:00:30,000\nThird\n',
  );
  for (const kind of ['voice', 'settings', 'workItem', 'text']) {
    let draft = await proc.createDubbingSession(subtitle);
    draft.speakers = [{ id: 1, name: 'Host', cueCount: 3 }];
    if (kind === 'voice')
      proc.setSpeakerVoiceMapping(draft, 1, config.voice, config.voice, config);
    if (kind === 'settings')
      proc.setSpeakerSettings(draft, 1, { speed: 1.25, pitch: 2 }, config);
    if (kind === 'workItem') draft.workItemId = 'draft-work-item';
    if (kind === 'text') {
      const cue = draft.cues[0];
      proc.saveDubbingCueTexts(draft, [
        {
          index: cue.index,
          startMs: cue.startMs,
          endMs: cue.endMs,
          baseText: cue.text,
          text: 'Text saved without engine configuration.',
        },
      ]);
      assert.equal(draft.lastConfig, undefined);
    }
    proc.disposeDubbingSession(draft.id);
    const restored = proc.restoreDubbingSession(draft.id);
    assert.equal(
      restored.kind,
      'ok',
      `unsynthesized ${kind} draft survives disposal`,
    );
    draft = restored.session;
    assert.ok(draft.cues.every((cue) => !cue.wavPath));
    if (kind === 'voice')
      assert.equal(draft.speakerVoiceMap['1'], config.voice);
    if (kind === 'settings')
      assert.deepEqual(draft.speakerSettings['1'], { speed: 1.25, pitch: 2 });
    if (kind === 'text')
      assert.equal(
        draft.cues[0].text,
        'Text saved without engine configuration.',
      );
    proc.deleteDubbingSessionData(draft.id);
  }
  let session = await proc.createDubbingSession(subtitle);
  session.speakers = [
    { id: 1, name: 'Host', cueCount: 2 },
    { id: 2, name: 'Guest', cueCount: 1 },
  ];
  session.speakerVoiceMap = {
    1: types.DUBBING_GLOBAL_VOICE_ID,
    2: types.DUBBING_GLOBAL_VOICE_ID,
  };
  session.cues.forEach((cue, i) => {
    cue.speakerIds = [i === 2 ? 2 : 1];
  });
  session.cues[1].voiceId = 'en-US-GuyNeural';
  await proc.runDubbingBatch(session, config, () => {});
  const guest = session.cues[2].wavPath;
  proc.setSpeakerSettings(session, 1, { speed: 1.5, pitch: 12 }, config);
  assert.deepEqual(
    session.cues.map((cue) => cue.needsUpdate),
    [true, true, false],
  );
  assert.deepEqual(store.readSessionMeta(session.id).speakerSettings['1'], {
    speed: 1.5,
    pitch: 12,
  });
  proc.disposeDubbingSession(session.id);
  session = proc.restoreDubbingSession(session.id).session;
  assert.deepEqual(session.speakerSettings['1'], { speed: 1.5, pitch: 12 });
  await proc.runDubbingBatch(session, config, () => {}, {
    staleOnly: true,
    speakerId: 1,
  });
  assert.equal(
    requests,
    5,
    'role regeneration includes explicit per-cue voices, excludes other roles',
  );
  assert.equal(session.cues[2].wavPath, guest);
  assert.ok(Math.abs(frequency(session.cues[0].wavPath) - 880) < 4);
  assert.ok(Math.abs(session.cues[0].finalMs - 2000) < 90);
  const artifacts = () =>
    fs
      .readdirSync(session.workDir)
      .filter((file) => file.endsWith('.wav'))
      .sort();
  assert.deepEqual(
    artifacts(),
    session.cues.map((cue) => path.basename(cue.wavPath)).sort(),
    'successful DSP retains only authoritative cue audio',
  );
  assert.equal(proc.syncDubbingVoiceStaleness(session, config), 0);
  const audioBeforeMedia = session.cues.map((cue) => cue.wavPath);
  await proc.setDubbingMedia(session, source);
  assert.equal(session.videoPath, source);
  assert.equal(session.mediaDurationMs, 3000);
  assert.deepEqual(
    session.cues.map((cue) => cue.wavPath),
    audioBeforeMedia,
  );
  assert.equal(store.readSessionMeta(session.id).videoPath, source);
  await assert.rejects(
    proc.setDubbingMedia(session, subtitle),
    /无法读取媒体时长/,
  );
  assert.equal(session.videoPath, source);
  const mediaRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('injected media disk failure');
  };
  try {
    await assert.rejects(
      proc.setDubbingMedia(session, undefined),
      /disk failure/,
    );
  } finally {
    fs.renameSync = mediaRename;
  }
  assert.equal(session.videoPath, source);
  assert.equal(session.running, false);
  await proc.setDubbingMedia(session, undefined);
  assert.equal(store.readSessionMeta(session.id).videoPath, undefined);
  const snapshot = structuredClone(session.speakerSettings);
  const rename = fs.renameSync;
  const savedConfig = structuredClone(session.lastConfig);
  for (const invalid of [
    null,
    { ...config, engine: { kind: 'cloud', providerId: 4 } },
    { ...config, engine: { kind: 'local', modelId: '' } },
    ...[
      { background: 'invalid' },
      { output: 'invalid' },
      { audioFormat: 'invalid' },
      { overlapMode: 'invalid' },
      { overflow: 'invalid' },
      { cloneQuality: 'invalid' },
      { localConcurrency: 1.5 },
      { localConcurrency: 4 },
      { exportShiftedSubtitle: 'false' },
      { language: 4 },
    ].map((fields) => ({ ...config, ...fields })),
  ]) {
    assert.throws(
      () => proc.saveDubbingConfig(session, invalid),
      /Invalid dubbing configuration/,
    );
    assert.deepEqual(session.lastConfig, savedConfig);
    assert.deepEqual(
      store.readSessionMeta(session.id).configSnapshot,
      savedConfig,
    );
  }
  const savedCues = session.cues.map((cue) => ({
    needsUpdate: cue.needsUpdate,
    synthesizedVoiceId: cue.synthesizedVoiceId,
  }));
  const sourceBeforeTextEdit = fs.readFileSync(subtitle, 'utf8');
  const textEdits = session.cues.slice(0, 2).map((cue) => ({
    index: cue.index,
    startMs: cue.startMs,
    endMs: cue.endMs,
    baseText: cue.text,
    text: `${cue.text} Edited.`,
  }));
  const unchangedTextState = JSON.stringify(session.cues);
  assert.throws(
    () =>
      proc.saveDubbingCueTexts(session, [
        textEdits[0],
        { ...textEdits[1], baseText: 'stale' },
      ]),
    /changed/,
  );
  assert.equal(JSON.stringify(session.cues), unchangedTextState);
  assert.throws(
    () => proc.saveDubbingCueTexts(session, [textEdits[0], textEdits[0]]),
    /Duplicate/,
  );
  assert.throws(
    () =>
      proc.saveDubbingCueTexts(session, [{ ...textEdits[0], startMs: 999999 }]),
    /changed/,
  );
  fs.renameSync = () => {
    throw new Error('text disk failure');
  };
  try {
    assert.throws(
      () => proc.saveDubbingCueTexts(session, textEdits),
      /text disk failure/,
    );
    assert.equal(JSON.stringify(session.cues), unchangedTextState);
  } finally {
    fs.renameSync = rename;
  }
  proc.saveDubbingCueTexts(session, textEdits);
  proc.saveDubbingCueTexts(session, textEdits);
  assert.equal(session.cues[0].needsUpdate, true);
  assert.equal(
    store.readSessionMeta(session.id).cues[0].text,
    textEdits[0].text,
  );
  assert.equal(fs.readFileSync(subtitle, 'utf8'), sourceBeforeTextEdit);
  proc.saveDubbingCueTexts(
    session,
    textEdits.map((edit) => ({
      ...edit,
      baseText: edit.text,
      text: edit.baseText,
    })),
  );
  assert.equal(JSON.stringify(session.cues), unchangedTextState);
  fs.renameSync = () => {
    throw new Error('injected disk failure');
  };
  try {
    assert.throws(
      () => proc.saveDubbingConfig(session, { ...config, globalSpeed: 1.4 }),
      /disk failure/,
    );
    assert.deepEqual(session.lastConfig, savedConfig);
    assert.deepEqual(
      session.cues.map((cue) => ({
        needsUpdate: cue.needsUpdate,
        synthesizedVoiceId: cue.synthesizedVoiceId,
      })),
      savedCues,
    );
    assert.deepEqual(
      store.readSessionMeta(session.id).configSnapshot,
      savedConfig,
    );
    assert.throws(
      () => proc.setSpeakerSettings(session, 1, { speed: 1, pitch: 0 }, config),
      /disk failure/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(session.speakerSettings, snapshot);
  proc.saveDubbingConfig(session, { ...config, globalSpeed: 1.4 });
  assert.equal(
    store.readSessionMeta(session.id).configSnapshot.globalSpeed,
    1.4,
  );
  assert.ok(session.cues.some((cue) => cue.needsUpdate));
  proc.saveDubbingConfig(session, config);
  assert.equal(proc.syncDubbingVoiceStaleness(session, config), 0);
  assert.deepEqual(store.readSessionMeta(session.id).speakerSettings, snapshot);
  proc.setSpeakerVoiceMapping(
    session,
    1,
    'en-US-GuyNeural',
    config.voice,
    config,
  );
  assert.deepEqual(
    session.cues.map((cue) => cue.needsUpdate),
    [true, false, false],
  );
  assert.equal(
    store.readSessionMeta(session.id).speakerVoiceMap['1'],
    'en-US-GuyNeural',
  );
  proc.setSpeakerVoiceMapping(
    session,
    1,
    types.DUBBING_GLOBAL_VOICE_ID,
    config.voice,
    config,
  );
  assert.deepEqual(
    session.cues.map((cue) => cue.needsUpdate),
    [false, false, false],
    'reverting voice clears only actual stale state',
  );
  session.speakerVoiceConflicts = { 1: ['one', 'two'] };
  proc.persistDubbingSession(session);
  fs.renameSync = () => {
    throw new Error('injected voice disk failure');
  };
  try {
    assert.throws(
      () =>
        proc.setSpeakerVoiceMapping(
          session,
          1,
          'en-US-GuyNeural',
          config.voice,
          config,
        ),
      /disk failure/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(session.speakerVoiceMap['1'], types.DUBBING_GLOBAL_VOICE_ID);
  assert.deepEqual(session.speakerVoiceConflicts, { 1: ['one', 'two'] });
  assert.deepEqual(
    session.cues.map((cue) => cue.needsUpdate),
    [false, false, false],
  );
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.deepEqual(
    store.readSessionMeta(session.id).speakerVoiceConflicts,
    { 1: ['one', 'two'] },
    'failed strict write preserves queued snapshot',
  );
  proc.setSpeakerVoiceMapping(
    session,
    1,
    types.DUBBING_GLOBAL_VOICE_ID,
    config.voice,
    config,
  );
  assert.deepEqual(store.readSessionMeta(session.id).speakerVoiceConflicts, {});
  const previousWav = session.cues[0].wavPath,
    previousKey = session.cues[0].synthesizedInputKey;
  proc.setSpeakerSettings(session, 1, { speed: 1, pitch: 0 }, config);
  failNext = true;
  await assert.rejects(
    proc.resynthesizeCue(session, 0, {}, config),
    /injected synthesis/,
  );
  assert.equal(session.cues[0].wavPath, previousWav);
  assert.equal(session.cues[0].synthesizedInputKey, previousKey);
  assert.equal(session.cues[0].needsUpdate, true);
  assert.deepEqual(
    artifacts(),
    session.cues.map((cue) => path.basename(cue.wavPath)).sort(),
    'failed synthesis removes partial attempt and retains prior artifacts',
  );
  await assert.rejects(proc.buildDubTrack(session, { config }), /重新生成/);
  cancelNext = true;
  await assert.rejects(proc.resynthesizeCue(session, 0, {}, config));
  assert.equal(session.cues[0].wavPath, previousWav);
  assert.deepEqual(
    artifacts(),
    session.cues.map((cue) => path.basename(cue.wavPath)).sort(),
    'cancelled attempt leaves no intermediate WAV',
  );
  session.running = true;
  assert.throws(
    () =>
      proc.setSpeakerVoiceMapping(
        session,
        1,
        config.voice,
        config.voice,
        config,
      ),
    /busy/,
  );
  assert.throws(
    () => proc.setSpeakerSettings(session, 1, { speed: 1, pitch: 0 }, config),
    /busy/,
  );
  session.running = false;
  const sample = await proc.previewVoice(config.engine, config.voice, 'Hello', {
    speakerSettings: { speed: 1.5, pitch: 12 },
  });
  assert.ok(Math.abs(frequency(sample.wavPath) - 880) < 4);
  assert.ok(Math.abs(sample.durationMs - 2000) < 90);
  const previewFiles = () => fs.readdirSync(path.join(root, 'dubbing')).sort();
  const clipped = await proc.previewVoice(
    config.engine,
    config.voice,
    'Hello',
    {
      speakerSettings: { speed: 0.5, pitch: 0 },
      maxDurationMs: 3000,
    },
  );
  assert.equal(audio.readWavInfo(clipped.wavPath).durationMs, 3000);
  assert.ok(Math.abs(frequency(clipped.wavPath) - 440) < 4);
  assert.deepEqual(
    previewFiles(),
    [path.basename(sample.wavPath), path.basename(clipped.wavPath)].sort(),
  );
  const beforePreviewFailure = previewFiles();
  failNext = true;
  await assert.rejects(
    proc.previewVoice(config.engine, config.voice, 'Hello', {
      maxDurationMs: 3000,
    }),
    /injected synthesis/,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    proc.previewVoice(config.engine, config.voice, 'Hello', {
      signal: cancelled.signal,
      maxDurationMs: 3000,
    }),
  );
  assert.deepEqual(
    previewFiles(),
    beforePreviewFailure,
    'failed and cancelled previews clean partial files',
  );

  const draft = await proc.createDubbingSession(subtitle);
  proc.setCueVoiceOverride(draft, 0, 'echo');
  assert.equal(store.readSessionMeta(draft.id).cues[0].voiceId, 'echo');
  fs.renameSync = () => {
    throw new Error('injected cue disk failure');
  };
  try {
    assert.throws(
      () => proc.setCueVoiceOverride(draft, 0, 'alloy'),
      /cue disk/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(draft.cues[0].voiceId, 'echo');
  assert.equal(store.readSessionMeta(draft.id).cues[0].voiceId, 'echo');
  proc.disposeDubbingSession(draft.id);

  // A failed publication must preserve the previous file referenced by session.json.
  const oldCue = { ...session.cues[1] };
  let publications = 0;
  fs.renameSync = (...args) => {
    publications++;
    if (publications > 1) throw new Error('injected publication failure');
    return rename(...args);
  };
  try {
    await assert.rejects(
      proc.resynthesizeCue(session, 1, {}, config),
      /publication failure/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(session.cues[1].wavPath, oldCue.wavPath);
  assert.ok(fs.existsSync(oldCue.wavPath));
  assert.equal(
    store.readSessionMeta(session.id).cues[1].wavFile,
    path.basename(oldCue.wavPath),
  );
  assert.deepEqual(
    artifacts(),
    session.cues.map((cue) => path.basename(cue.wavPath)).sort(),
  );
  proc.disposeDubbingSession(session.id);
  const sidecar = path.join(root, 'roles.json');
  const assignments = [1, 1, 2];
  const writeRoles = (ids, names = ['Host', 'Guest', 'Merged']) =>
    fs.writeFileSync(
      sidecar,
      JSON.stringify({
        version: 2,
        meta: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sourceFile: subtitle,
        },
        speakers: [1, 2, 3].map((id) => ({
          id,
          displayName: names[id - 1],
          color: '#218C74',
        })),
        cues: ids.map((id, index) => ({
          id: String(index + 1),
          startMs: index * 10000,
          endMs: (index + 1) * 10000,
          source: 'Line',
          target: '',
          speakerIds: [id],
        })),
      }),
    );
  writeRoles(assignments);
  let merged = await proc.createDubbingSession(subtitle, undefined, sidecar);
  proc.setSpeakerVoiceMapping(
    merged,
    1,
    types.DUBBING_GLOBAL_VOICE_ID,
    config.voice,
    config,
  );
  proc.setSpeakerVoiceMapping(
    merged,
    2,
    types.DUBBING_GLOBAL_VOICE_ID,
    config.voice,
    config,
  );
  proc.setSpeakerSettings(merged, 1, { speed: 1.25, pitch: 2 }, config);
  proc.disposeDubbingSession(merged.id);
  writeRoles(assignments, ['Renamed host', 'Guest', 'Merged']);
  merged = proc.restoreDubbingSession(merged.id).session;
  assert.equal(merged.speakers[0].name, 'Renamed host');
  assert.deepEqual(merged.speakerSettings['1'], { speed: 1.25, pitch: 2 });
  assert.deepEqual(merged.speakerSettingsConflicts, {});
  proc.disposeDubbingSession(merged.id);
  writeRoles([3, 3, 2]);
  merged = proc.restoreDubbingSession(merged.id).session;
  assert.deepEqual(
    merged.speakerSettings['3'],
    { speed: 1.25, pitch: 2 },
    'one source role migrates settings to new ID',
  );
  assert.deepEqual(merged.speakerSettingsConflicts, {});
  proc.disposeDubbingSession(merged.id);
  writeRoles([3, 3, 3]);
  merged = proc.restoreDubbingSession(merged.id).session;
  assert.deepEqual(
    merged.speakerSettingsConflicts['3'],
    [
      { speed: 1.25, pitch: 2 },
      { speed: 1, pitch: 0 },
    ],
    'merging with default settings still needs confirmation',
  );
  await assert.rejects(
    proc.runDubbingBatch(merged, config, () => {}),
    /确认合并角色/,
  );
  await assert.rejects(
    proc.resynthesizeCue(merged, 0, {}, config),
    /确认合并角色/,
  );
  await assert.rejects(proc.buildDubTrack(merged, { config }), /确认合并角色/);
  proc.disposeDubbingSession(merged.id);
  merged = proc.restoreDubbingSession(merged.id).session;
  assert.equal(
    merged.speakerSettingsConflicts['3'].length,
    2,
    'unresolved choices survive reopening',
  );
  fs.renameSync = () => {
    throw new Error('injected merge disk failure');
  };
  try {
    assert.throws(
      () => proc.setSpeakerSettings(merged, 3, { speed: 1, pitch: 0 }, config),
      /disk failure/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(merged.speakerSettingsConflicts['3'].length, 2);
  proc.setSpeakerSettings(merged, 3, { speed: 1, pitch: 0 }, config);
  proc.disposeDubbingSession(merged.id);
  merged = proc.restoreDubbingSession(merged.id).session;
  assert.deepEqual(merged.speakerSettings['3'], { speed: 1, pitch: 0 });
  assert.deepEqual(merged.speakerSettingsConflicts, {});
  proc.disposeDubbingSession(merged.id);
  console.log(
    JSON.stringify({
      root,
      checks:
        'real WAV tempo/pitch/duration/sample-rate, neutral cache identity, role-only stale/rebuild, unsynthesized restore, atomic voice/settings/media rollback, pending snapshot recovery, role rename/migration/merge confirmation, success/failure/cancel WAV cleanup, preview and stale export guard',
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
  });
