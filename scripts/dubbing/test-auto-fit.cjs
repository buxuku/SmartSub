const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-auto-fit-'));
const load = Module._load;
const loader = require.extensions['.ts'];
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
let source;
const requests = [];
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
        requests.push(req);
        fs.copyFileSync(source, req.outWavPath);
        return { durationMs: 1 }; // Alignment must measure the WAV, not trust transport metadata.
      },
    };
  return load.call(this, request, parent, isMain);
};

async function main() {
  const audio = require('../../main/helpers/dubbing/audioPipeline.ts');
  const proc = require('../../main/helpers/dubbing/dubbingProcessor.ts');
  const store = require('../../main/helpers/dubbing/sessionStore.ts');
  store.setDubbingSessionsRoot(path.join(root, 'sessions'));
  const config = {
    engine: { kind: 'cloud', providerId: 'test' },
    voice: 'en-US-AriaNeural',
    globalSpeed: 1,
    background: 'mute',
    output: 'audioOnly',
  };
  const tone = (ms) => {
    const target = path.join(root, `tone-${ms}.wav`);
    if (!fs.existsSync(target))
      execFileSync(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=if(lt(t\\,${(ms - 120) / 1000})\\,0.1*sin(2*PI*440*t)\\,0.4*sin(2*PI*880*t)):s=24000:d=${ms / 1000}`,
        '-c:a',
        'pcm_s16le',
        target,
      ]);
    return target;
  };
  const samples = (file) => {
    const info = audio.readWavInfo(file);
    const data = fs.readFileSync(file);
    return {
      info,
      values: Array.from(
        { length: info.dataBytes / 2 },
        (_, index) => data.readInt16LE(info.dataOffset + index * 2) / 32768,
      ),
    };
  };
  const frequency = (file, start, end) => {
    const { info, values } = samples(file);
    const a = Math.round(start * info.sampleRate),
      b = Math.round(end * info.sampleRate);
    let crossings = 0;
    for (let i = a + 1; i < b; i++)
      if (values[i - 1] <= 0 && values[i] > 0) crossings++;
    return (crossings * info.sampleRate) / (b - a);
  };
  const subtitle = path.join(root, 'fit.srt');
  fs.writeFileSync(
    subtitle,
    '1\n00:00:00,000 --> 00:00:02,000\nThis deliberately lengthy subtitle must not cause any estimated automatic pre-speed change.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond.\n',
  );
  let session = await proc.createDubbingSession(subtitle);
  for (const [duration, expected] of [
    [1900, 'done'],
    [2000, 'done'],
    [2001, 'done'],
    [2299, 'done'],
    [2300, 'done'],
    [2301, 'overlong'],
    [2800, 'overlong'],
  ]) {
    source = tone(duration);
    await proc.resynthesizeCue(session, 0, {}, config);
    const cue = session.cues[0];
    assert.equal(cue.status, expected, `duration=${duration}`);
    assert.equal(cue.originalMeasuredMs, duration);
    assert.equal(requests.at(-1).speed, 1, 'no hidden pre-speed');
    assert.equal(
      cue.finalMs,
      expected === 'overlong' ? duration : Math.min(duration, 2000),
    );
    assert.ok(
      Math.abs(frequency(cue.wavPath, 0.2, 1.2) - 440) < 3,
      'pitch preserved',
    );
    if (duration > 2000 && expected === 'done') {
      const { info, values } = samples(cue.wavPath);
      const tail = values.slice(Math.round(info.sampleRate * 1.92));
      assert.ok(
        Math.max(...tail.map(Math.abs)) > 0.3,
        `final spoken marker retained: ${duration}`,
      );
    }
  }
  await assert.rejects(proc.buildDubTrack(session, { config }), /超限/);
  const previous = { ...session.cues[0] };
  const rename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('injected write failure');
  };
  try {
    assert.throws(
      () => proc.borrowFollowingSilence(session, 0, config),
      /write failure/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(session.cues[0], previous);
  assert.equal(store.readSessionMeta(session.id).cues[0].status, 'overlong');
  session.running = true;
  assert.throws(() => proc.borrowFollowingSilence(session, 0, config), /busy/);
  session.running = false;
  proc.borrowFollowingSilence(session, 0, config);
  assert.equal(session.cues[0].borrowedMs, 800);
  assert.equal(session.cues[0].wavPath, previous.wavPath);
  assert.equal(session.cues[1].startMs, 4000);
  proc.disposeDubbingSession(session.id);
  session = proc.restoreDubbingSession(session.id).session;
  assert.equal(session.cues[0].borrowedMs, 800);
  assert.equal(session.cues[0].originalMeasuredMs, 2800);
  assert.equal(session.cues[0].needsUpdate, false);
  source = tone(1800);
  await proc.resynthesizeCue(session, 1, {}, config);
  const track = await proc.buildDubTrack(session, {
    config,
    overlapMode: 'shift',
  });
  assert.deepEqual(
    track.plan.items.map((cue) => cue.targetStartMs),
    [0, 4000],
  );
  assert.equal(track.plan.items[0].durationMs, 2800);
  assert.ok(
    Math.abs(frequency(track.trackPath, 4.2, 4.8) - 440) < 3,
    'next cue starts at original timestamp',
  );
  const trackSamples = samples(track.trackPath);
  assert.ok(
    trackSamples.values.slice(72000, 95000).every((sample) => sample === 0),
    'remaining gap is silent',
  );
  const exportConfig = { ...config, exportShiftedSubtitle: true };
  const base = path.join(root, 'fit-dubbed');
  fs.writeFileSync(base + '.dubbed.srt', 'existing captions');
  const firstExport = await proc.exportDubbing(session, exportConfig, () => {});
  assert.equal(firstExport.outputPath, base + '_2.wav');
  assert.equal(firstExport.shiftedSubtitlePath, base + '_2.dubbed.srt');
  assert.deepEqual(
    fs.readFileSync(firstExport.outputPath),
    fs.readFileSync(track.trackPath),
  );
  assert.equal(
    fs.readFileSync(base + '.dubbed.srt', 'utf8'),
    'existing captions',
  );
  const secondExport = await proc.exportDubbing(
    session,
    exportConfig,
    () => {},
  );
  assert.equal(secondExport.outputPath, base + '_3.wav');
  const mp3 = await proc.exportDubbing(
    session,
    { ...exportConfig, audioFormat: 'mp3' },
    () => {},
  );
  assert.ok(fs.statSync(mp3.outputPath).size > 1000);
  assert.equal(mp3.outputPath, base + '_4.mp3');
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    if (String(to).endsWith('.dubbed.srt'))
      throw Object.assign(new Error('subtitle publication failure'), {
        code: 'ENOSPC',
      });
    return link(from, to);
  };
  try {
    await assert.rejects(
      proc.exportDubbing(session, exportConfig, () => {}),
      /publication failure/,
    );
  } finally {
    fs.linkSync = link;
  }
  assert.equal(session.running, false);
  assert.equal(fs.existsSync(base + '_4.wav'), false);
  await assert.rejects(
    proc.exportDubbing(session, exportConfig, (event) => {
      if (event.stage === 'mux') proc.cancelDubbing(session);
    }),
  );
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith('.smartsub-compose-')),
    false,
  );
  const pendingTrack = proc.buildDubTrack(session, { config });
  assert.equal(session.running, true);
  await assert.rejects(proc.buildDubTrack(session, { config }), /正在使用/);
  await assert.rejects(proc.resynthesizeCue(session, 0, {}, config), /busy/);
  const independentTrack = await pendingTrack;
  assert.notEqual(independentTrack.trackPath, track.trackPath);
  assert.deepEqual(
    fs.readFileSync(independentTrack.trackPath),
    fs.readFileSync(track.trackPath),
  );
  const artifact = session.cues[0].wavPath;
  source = tone(2800);
  await proc.resynthesizeCue(session, 0, {}, config);
  assert.equal(
    session.cues[0].borrowedMs,
    undefined,
    'resynthesis resets explicit alignment consent',
  );
  assert.equal(session.cues[0].status, 'overlong');
  assert.notEqual(session.cues[0].wavPath, artifact);
  assert.equal(fs.existsSync(artifact), false);
  const beforeBatch = session.cues.map((cue) => cue.wavPath);
  fs.renameSync = () => {
    throw new Error('batch publication failure');
  };
  try {
    const result = await proc.runDubbingBatch(session, config, () => {}, {
      force: true,
    });
    assert.deepEqual(result.failedIndexes, [0, 1]);
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(
    session.cues.map((cue) => cue.wavPath),
    beforeBatch,
  );
  assert.ok(beforeBatch.every((file) => fs.existsSync(file)));
  assert.deepEqual(
    store.readSessionMeta(session.id).cues.map((cue) => cue.wavFile),
    beforeBatch.map((file) => path.basename(file)),
  );
  assert.deepEqual(
    fs
      .readdirSync(session.workDir)
      .filter((file) => file.startsWith('cue-') && file.endsWith('.wav'))
      .sort(),
    beforeBatch.map((file) => path.basename(file)).sort(),
    'failed batch publication cleans only attempted audio',
  );
  await proc.resynthesizeCue(session, 0, {}, config);
  proc.borrowFollowingSilence(session, 0, config);
  await proc.setDubbingMedia(session, tone(2600));
  assert.equal(session.cues[0].status, 'overlong');
  assert.equal(
    session.cues[0].borrowedMs,
    undefined,
    'new shorter media invalidates prior borrowing',
  );
  await proc.setDubbingMedia(session, undefined);
  session.mediaDurationMs = 2600;
  assert.throws(
    () => proc.borrowFollowingSilence(session, 0, config),
    /空白不足/,
  );
  session.mediaDurationMs = 0;
  session.cues[1].startMs = 2500;
  assert.throws(
    () => proc.borrowFollowingSilence(session, 0, config),
    /空白不足/,
  );
  session.cues[1].startMs = 4000;
  session.detectedLanguage = 'en';
  session.cues.forEach((cue) => {
    cue.text = 'X';
  });
  proc.syncDubbingVoiceStaleness(session, config);
  assert.equal(
    session.detectedLanguage,
    'en',
    'ambiguous shorter text does not erase established language',
  );
  proc.flushDubbingSession(session);
  assert.equal(store.readSessionMeta(session.id).detectedLanguage, 'en');
  session.cues[0].synthesizedInputKey = 'legacy-alignment';
  assert.throws(
    () => proc.borrowFollowingSilence(session, 0, config),
    /重新生成/,
  );
  await assert.rejects(
    proc.resynthesizeCue(
      session,
      0,
      { text: 'Short.', expectedCue: { text: 'other window text' } },
      config,
    ),
    /其他窗口/,
  );
  const speechInput = process.env.SMARTSUB_TEST_SPEECH;
  let speechEvidence;
  if (speechInput) {
    const normalized = path.join(root, 'speech-original.wav');
    await audio.transcodeToPcm16Wav(speechInput, normalized, {
      sampleRate: 24000,
    });
    const originalMs = audio.wavDurationMs(normalized);
    assert.ok(originalMs > 1000);
    const variants = [];
    for (const ratio of [1.05, 1.1, 1.15]) {
      const targetMs = Math.ceil(originalMs / ratio);
      const fitted = path.join(root, `speech-fit-${ratio}.wav`);
      await audio.fitSpeechWav(normalized, fitted, targetMs);
      const measuredMs = audio.wavDurationMs(fitted);
      assert.ok(Math.abs(measuredMs - targetMs) <= 1);
      const { values } = samples(fitted);
      assert.ok(values.some((value) => Math.abs(value) > 0.01));
      assert.ok(
        values.every((value) => Number.isFinite(value) && Math.abs(value) <= 1),
      );
      variants.push({ ratio, targetMs, measuredMs, file: fitted });
    }
    speechEvidence = {
      input: speechInput,
      originalMs,
      variants,
      scope:
        'Real speech DSP duration and finite non-silent PCM; listening quality requires human review.',
    };
  }
  proc.disposeDubbingSession(session.id);
  console.log(
    JSON.stringify({
      root,
      speechEvidence,
      checks:
        '15% exact boundaries, true WAV measurement, pitch and tail marker preservation, silence borrowing and no timeline shifts, atomic rollback/reopen, media bounds, stale audio and multiwindow conflict guards',
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = load;
    require.extensions['.ts'] = loader;
  });
