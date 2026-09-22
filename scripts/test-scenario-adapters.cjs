const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'smartsub-scenario-adapters-'),
);
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
let settings = { vadThreshold: 0.8 };
let response;
let dispatched;
require.extensions['.ts'] = (module, filename) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/storeManager'))
    return { logMessage() {}, store: { get: () => settings } };
  if (request.endsWith('/modelCatalog'))
    return {
      getFasterWhisperModelsPath: () => root,
      inspectCt2ModelSnapshot: () => ({ snapshotDir: root }),
    };
  if (request.endsWith('/pythonRuntime/paths')) return {};
  if (request === '../pythonRuntime')
    return {
      getPythonRuntimeManager: () => ({
        ensureStarted: async () => ({ engines: { faster_whisper: true } }),
        transcribe: (params) => {
          dispatched = params;
          return { id: 'fixture', result: Promise.resolve(response) };
        },
      }),
    };
  if (request.endsWith('/fileUtils')) {
    const {
      formatTime,
      parseTime,
    } = require('../main/helpers/subtitleSegmentation.ts');
    return {
      secondsToSubtitleTime: formatTime,
      subtitleTimeToSeconds: parseTime,
      formatSrtContent: (cues) =>
        cues
          .map(
            ([start, end, text], i) =>
              `${i + 1}\n${start} --> ${end}\n${text.trim()}\n`,
          )
          .join('\n'),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const {
      fasterWhisperEngineAdapter,
    } = require('../main/helpers/engines/fasterWhisperEngine.ts');
    const {
      localCliEngineAdapter,
    } = require('../main/helpers/engines/localCliEngine.ts');
    const { parseSubtitleCues } = require('../main/helpers/subtitleFormats.ts');
    const events = [];
    const ctx = (name) => ({
      event: { sender: { send: (...args) => events.push(args) } },
      file: {
        uuid: name,
        fileName: name,
        srtFile: path.join(root, `${name}.srt`),
        tempAudioFile: path.join(root, `${name}.wav`),
        directory: root,
      },
      formData: {
        transcriptionEngine: 'fasterWhisper',
        model: 'base',
        subtitleOutcome: 'clean',
        vadThreshold: 0.35,
        subtitleMaxDuration: 3,
        subtitleMaxGap: 0.25,
        preserveSpeechPauses: true,
        maxSubtitleChars: 28,
      },
    });
    response = {
      segments: [
        {
          start: 0,
          end: 1,
          text: 'First I',
          words: [
            { start: 0, end: 0.2, word: 'First' },
            { start: 0.6, end: 0.8, word: ' I' },
          ],
        },
        {
          start: 2,
          end: 11,
          text: 'This fallback segment has several words and must be split correctly.',
        },
        {
          start: 12,
          end: 13,
          text: 'done',
          words: [{ start: 12, end: 13, word: 'done' }],
        },
      ],
    };
    const faster = ctx('mixed');
    const output = await fasterWhisperEngineAdapter.transcribe(faster);
    const cues = parseSubtitleCues(fs.readFileSync(output, 'utf8'), 'srt');
    assert.equal(dispatched.vad_threshold, 0.35);
    assert.equal(dispatched.condition_on_previous_text, false);
    assert.deepEqual(
      cues.slice(0, 2).map((cue) => [cue.startMs, cue.endMs, cue.text]),
      [
        [0, 200, 'First'],
        [600, 800, 'I'],
      ],
    );
    assert.ok(cues.slice(2, -1).length >= 3);
    assert.ok(cues.every((cue) => cue.endMs - cue.startMs <= 3001));
    assert.equal(
      cues
        .slice(2, -1)
        .map((cue) => cue.text)
        .join('')
        .replace(/\s/g, ''),
      response.segments[1].text.replace(/\s/g, ''),
    );
    assert.equal(cues.at(-1).startMs, 12000);
    assert.equal(cues.at(-1).endMs, 13000);
    assert.ok(fs.existsSync(faster.file.wordTimelineFile));

    // Verify mode defaults reach the actual runtime dispatch, and task-level
    // overrides still win. Mode changes must not mutate the stored settings.
    settings = { vadThreshold: 0.5, vadMinSpeechDuration: 250 };
    for (const [name, formData, threshold, minSpeech] of [
      ['accurate', { subtitleOutcome: 'accurate' }, 0.35, 100],
      ['balanced', { subtitleOutcome: 'balanced' }, 0.5, 250],
      [
        'accurate-override',
        {
          subtitleOutcome: 'accurate',
          vadThreshold: 0.6,
          vadMinSpeechDuration: 180,
        },
        0.6,
        180,
      ],
    ]) {
      const task = ctx(name);
      delete task.formData.vadThreshold;
      Object.assign(task.formData, formData);
      await fasterWhisperEngineAdapter.transcribe(task);
      assert.equal(dispatched.vad, true);
      assert.equal(dispatched.vad_threshold, threshold, name);
      assert.equal(dispatched.vad_min_speech_duration_ms, minSpeech, name);
      assert.equal(dispatched.vad_min_silence_duration_ms, 100, name);
      assert.equal(dispatched.vad_speech_pad_ms, 200, name);
      assert.equal(dispatched.speech_review, true, name);
      assert.equal(dispatched.condition_on_previous_text, undefined, name);
    }
    assert.deepEqual(settings, {
      vadThreshold: 0.5,
      vadMinSpeechDuration: 250,
    });

    const cliScript = path.join(root, 'fixture.cjs');
    const longSrt =
      '1\n00:00:00,000 --> 00:00:09,000\nA long CLI subtitle with several words to split into short cues.\n';
    fs.writeFileSync(
      cliScript,
      `require('node:fs').writeFileSync(process.argv[2], ${JSON.stringify(longSrt)});`,
    );
    settings = {
      whisperCommand: `"${process.execPath}" "${cliScript}" "\${srtFile}"`,
    };
    const cli = ctx('cli');
    cli.formData.transcriptionEngine = 'localCli';
    const cliOutput = await localCliEngineAdapter.transcribe(cli);
    const cliCues = parseSubtitleCues(
      fs.readFileSync(cliOutput, 'utf8'),
      'srt',
    );
    assert.ok(cliCues.length >= 3);
    assert.ok(cliCues.every((cue) => cue.endMs - cue.startMs <= 3001));
    assert.equal(cliCues[0].startMs, 0);
    assert.equal(cliCues.at(-1).endMs, 9000);
    assert.equal(events.at(-1)[1].extractSubtitle, 'done');
    events.length = 0;
    fs.writeFileSync(cliScript, 'process.exit(0);');
    await assert.rejects(
      localCliEngineAdapter.transcribe(ctx('missing')),
      /ENOENT/,
    );
    assert.ok(
      !events.some((event) => event[1]?.extractSubtitle === 'done'),
      'missing CLI output must not report success',
    );
    console.log(
      `Scenario adapters passed: VAD runtime parameters, mixed word/segment output, real CLI process, missing output failure. Evidence: ${root}`,
    );
  } finally {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
