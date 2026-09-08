'use strict';
// Run after test:engines. Unpack official model archives into the supplied directory.
// node scripts/smoke-parakeet.cjs <archive-directory> <output-directory>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { Worker } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const modelsRoot = path.resolve(
  process.argv[2] || 'node_modules/.cache/parakeet-416/models',
);
const outputRoot = path.resolve(
  process.argv[3] || 'node_modules/.cache/parakeet-416/evidence',
);
fs.mkdirSync(outputRoot, { recursive: true });

// Isolate Electron settings while exercising the real engine and subtitle helpers.
const settings = {
  parakeetModelsPath: modelsRoot,
  parakeetProvider: 'cpu',
  parakeetNumThreads: 2,
};
const store = { get: (key) => (key === 'settings' ? settings : undefined) };
const originalLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (id === 'electron')
    return {
      app: {
        getPath: () => outputRoot,
        getAppPath: () => root,
        isPackaged: false,
      },
    };
  if (
    parent?.filename.startsWith(path.join(root, 'main')) &&
    /(?:^|\/)store(?:Manager)?$/.test(id)
  ) {
    return { store, logMessage() {} };
  }
  if (id.endsWith('/sherpaFunasrRuntime'))
    return { getSherpaAsrRuntime: () => runtime };
  return originalLoad.call(this, id, parent, isMain);
};
require.extensions['.ts'] = (module, filename) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
};

const catalog = require('../main/helpers/parakeetModelCatalog.ts');
for (const id of catalog.getParakeetModelIds()) {
  const dir = path.join(modelsRoot, id);
  const unpacked = path.join(
    modelsRoot,
    catalog.PARAKEET_MODELS[id].archiveInnerDir,
  );
  if (!fs.existsSync(dir) && fs.existsSync(unpacked))
    fs.symlinkSync(unpacked, dir, 'dir');
  assert.ok(catalog.isParakeetModelInstalled(id), `Missing model ${id}`);
}

let worker;
let seq = 0;
let lastRawResult;
const pending = new Map();
const runtime = {
  transcribe(model, audioFile, progress) {
    const id = `smoke-${++seq}`;
    const result = new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject, progress }),
    );
    worker.postMessage({ type: 'transcribe', id, ...model, audioFile });
    return { id, result };
  },
  cancel(id) {
    worker.postMessage({ type: 'cancel', id });
  },
  prewarm(model) {
    worker.postMessage({ type: 'load', ...model });
  },
};
const {
  parakeetEngineAdapter,
} = require('../main/helpers/engines/parakeetEngine.ts');
const { subtitleTimeToSeconds } = require('../main/helpers/fileUtils.ts');
const ffmpeg = require('ffmpeg-static');
const report = [];

function prepareAudio(input, name, repetitions = 1) {
  const out = path.join(outputRoot, `${name}.wav`);
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-stream_loop',
    String(repetitions - 1),
    '-i',
    input,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    out,
  ]);
  return out;
}

async function transcribe(id, audio, name, cancel = false) {
  const controller = new AbortController();
  const progress = [];
  let cueCount = 0;
  let punctuationCount = 0;
  const started = performance.now();
  const file = {
    tempAudioFile: audio,
    srtFile: path.join(outputRoot, `${name}.srt`),
  };
  let cancellationSent = false;
  const run = parakeetEngineAdapter.transcribe({
    file,
    formData: {
      model: id,
      transcriptionEngine: 'parakeet',
      sourceLanguage: id.endsWith('-ja') ? 'ja' : 'en',
    },
    event: {
      sender: {
        send(channel, ...args) {
          if (channel === 'taskProgressChange') {
            const percent = args.at(-1);
            progress.push(percent);
            if (cancel && percent >= 10 && percent < 100 && !cancellationSent) {
              cancellationSent = true;
              controller.abort();
            }
          }
        },
      },
    },
    signal: controller.signal,
  });
  if (cancel) {
    await assert.rejects(run, /cancel/i);
    assert.ok(cancellationSent, 'cancellation reached active decoding');
    assert.ok(!fs.existsSync(file.srtFile), 'cancelled run wrote no subtitle');
  } else {
    await run;
    fs.writeFileSync(
      path.join(outputRoot, `${name}.json`),
      JSON.stringify(lastRawResult, null, 2),
    );
    const srt = fs.readFileSync(file.srtFile, 'utf8');
    const cues = srt.trim().split(/\n\s*\n/);
    cueCount = cues.length;
    let previousEnd = 0;
    for (const cue of cues) {
      const lines = cue.split('\n');
      assert.match(
        lines[1],
        /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/,
      );
      const [start, end] = lines[1].split(' --> ').map(subtitleTimeToSeconds);
      assert.ok(
        start >= previousEnd && end > start,
        'ordered, non-overlapping subtitle times',
      );
      previousEnd = end;
      assert.ok(lines.slice(2).join('').trim());
    }
    if (id.endsWith('-ja')) {
      assert.match(srt, /[\u3040-\u30ff\u4e00-\u9fff]/, 'Japanese text');
      // Punctuation is model output, not guaranteed for every speech sample.
      const punctuation = /[\u3001\u3002!?]/g;
      punctuationCount = (srt.match(punctuation) || []).length;
      const rawText = lastRawResult.segments
        .map((segment) => segment.text)
        .join('');
      assert.equal(
        punctuationCount,
        (rawText.match(punctuation) || []).length,
        'preserve model punctuation',
      );
    } else assert.match(srt, /[a-zA-Z]{3}/, 'English text');
    assert.equal(progress.at(-1), 100);
  }
  const entry = {
    model: id,
    name,
    cancelled: cancel,
    elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2),
    rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2),
    progressEvents: progress.length,
    cueCount,
    punctuationCount,
  };
  report.push(entry);
  console.log(JSON.stringify(entry));
}

async function main() {
  worker = new Worker(
    path.join(root, 'extraResources/sherpa/worker/sherpa-worker.js'),
    {
      env: {
        ...process.env,
        SHERPA_ONNX_LIB_DIR: path.join(
          root,
          'extraResources/sherpa/native',
          `${process.platform}-${process.arch}`,
        ),
      },
    },
  );
  worker.on('message', (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'progress') entry.progress?.(msg.percent);
    if (msg.type === 'done' || msg.type === 'error') {
      pending.delete(msg.id);
      if (msg.type === 'done') {
        lastRawResult = msg;
        entry.resolve(msg);
      } else
        entry.reject(Object.assign(new Error(msg.message), { code: msg.code }));
    }
  });
  worker.on('error', (error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  });
  worker.on('exit', (code) => {
    for (const p of pending.values())
      p.reject(new Error(`worker exit ${code}`));
    pending.clear();
  });
  const timeout = setTimeout(() => worker.terminate(), 240_000);
  try {
    const v2 = 'parakeet-tdt-0.6b-v2';
    const v3 = 'parakeet-tdt-0.6b-v3';
    const ja = 'parakeet-tdt_ctc-0.6b-ja';
    const english = prepareAudio(
      path.join(modelsRoot, v2, 'test_wavs/0.wav'),
      'english',
    );
    const japanese = prepareAudio(
      path.join(modelsRoot, ja, 'test_wavs/test_ja_1.wav'),
      'japanese',
    );
    const japanese2 = prepareAudio(
      path.join(modelsRoot, ja, 'test_wavs/test_ja_2.wav'),
      'japanese-2',
    );
    const long = prepareAudio(japanese, 'japanese-long', 24);
    await transcribe(v2, english, 'v2-english');
    await transcribe(v3, english, 'v3-english');
    await transcribe(ja, japanese, 'ja-ctc');
    await transcribe(ja, japanese2, 'ja-ctc-2');
    await transcribe(ja, long, 'ja-long');
    await transcribe(ja, long, 'ja-cancel', true);
    await transcribe(v2, english, 'v2-after-cancel');
    fs.writeFileSync(
      path.join(outputRoot, 'smoke-results.json'),
      JSON.stringify(
        { platform: `${process.platform}-${process.arch}`, results: report },
        null,
        2,
      ),
    );
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
