'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const workerPath = path.resolve(
  __dirname,
  '../extraResources/sherpa/worker/sherpa-worker.js',
);
const wavIo = require('../extraResources/sherpa/worker/wav-io.js');
const helpers = require('../node_modules/.cache/engine-tests/main/helpers/sherpaOnnx/sherpaConfig.js');
const params = {
  num_threads: 2,
  provider: 'cpu',
  vad_threshold: 0.5,
  vad_min_speech_duration_ms: 250,
  vad_min_silence_duration_ms: 100,
  vad_max_speech_duration_s: 0,
};
const ctc = {
  modelType: 'nemo_ctc',
  asrModel: '/ja/model.int8.onnx',
  tokens: '/ja/tokens.txt',
  vadModel: '/vad.onnx',
  params,
};
const tdt = (version) => ({
  modelType: 'nemo_transducer',
  transducer: {
    encoder: `/${version}/encoder.int8.onnx`,
    decoder: `/${version}/decoder.int8.onnx`,
    joiner: `/${version}/joiner.int8.onnx`,
  },
  tokens: `/${version}/tokens.txt`,
  vadModel: '/vad.onnx',
  params,
});
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(overrides = {}) {
  const configs = [];
  const messages = [];
  let listener;
  let decode;
  const sherpa = {
    OfflineRecognizer: class {
      constructor(config) {
        configs.push(plain(config));
      }
      createStream() {
        return { acceptWaveform() {} };
      }
      decodeAsync() {
        return new Promise((resolve, reject) => {
          decode = { resolve, reject };
        });
      }
    },
    Vad: class {
      reset() {
        this.segment = null;
        this.fed = false;
      }
      acceptWaveform() {
        if (!this.fed)
          this.segment = { start: 0, samples: new Float32Array(512) };
        this.fed = true;
      }
      isEmpty() {
        return !this.segment;
      }
      front() {
        return this.segment;
      }
      pop() {
        this.segment = null;
      }
      flush() {}
    },
    readWave(file) {
      if (overrides.readWave) return overrides.readWave(file);
      if (file === 'missing.wav') throw new Error('missing audio');
      return { samples: new Float32Array(512) };
    },
    writeWave(file, wave) {
      if (overrides.writeWave) return overrides.writeWave(file, wave);
      return true;
    },
    OfflineSpeechDenoiser: class {
      run({ samples }) {
        return { samples, sampleRate: 16000 };
      }
    },
  };
  vm.runInNewContext(
    fs.readFileSync(workerPath, 'utf8'),
    {
      __dirname: path.dirname(workerPath),
      // wav-io.js 是纯 JS 模块，用真实实现；其余（原生库）用替身
      require: (id) =>
        id === 'path' ? path : id.endsWith('wav-io.js') ? wavIo : sherpa,
      process: {
        parentPort: {
          postMessage: (msg) => messages.push(plain(msg)),
          on: (_event, cb) => {
            listener = cb;
          },
        },
      },
    },
    { filename: workerPath },
  );
  return {
    configs,
    messages,
    send: (msg) => listener({ data: msg }),
    resolve: () => decode.resolve({ text: 'recognized text' }),
    reject: () => decode.reject(new Error('decode failed')),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  const h = harness();
  h.send({ type: 'load', ...tdt('v2') });
  assert.deepEqual(
    h.configs.at(-1),
    helpers.buildParakeetRecognizerConfig(
      tdt('v2').transducer,
      '/v2/tokens.txt',
      params,
    ),
  );
  h.send({ type: 'load', ...tdt('v2') });
  assert.equal(h.configs.length, 1, 'same model reuses recognizer');
  h.send({ type: 'load', ...tdt('v3') });
  assert.equal(h.configs.length, 2, 'v2 to v3 reloads');
  h.send({ type: 'load', ...ctc });
  assert.deepEqual(
    h.configs.at(-1),
    helpers.buildParakeetCtcRecognizerConfig(ctc.asrModel, ctc.tokens, params),
  );
  h.send({ type: 'load', ...ctc, params: { ...params, provider: 'cuda' } });
  assert.equal(h.configs.at(-1).modelConfig.provider, 'cuda');
  h.send({ type: 'load', ...ctc, params: { ...params, num_threads: 4 } });
  assert.equal(h.configs.at(-1).modelConfig.numThreads, 4);
  h.send({ type: 'load', ...ctc, asrModel: '/other/model.int8.onnx' });
  assert.equal(
    h.configs.at(-1).modelConfig.nemoCtc.model,
    '/other/model.int8.onnx',
  );

  h.send({ type: 'transcribe', id: 'active', audioFile: 'test.wav', ...ctc });
  const activeDetails = h.messages
    .filter((m) => m.id === 'active' && m.type === 'activity')
    .map((m) => m.detail);
  assert.ok(activeDetails.some((d) => d.phase === 'loadingModel'));
  assert.ok(activeDetails.some((d) => d.phase === 'readingAudio'));
  assert.equal(activeDetails.at(-1).phase, 'recognizing');
  assert.equal(
    activeDetails.at(-1).units[0].id,
    1,
    'publish segment start before decoder returns',
  );
  assert.equal(activeDetails.at(-1).processedSeconds, 0);
  const before = h.configs.length;
  h.send({ type: 'load', ...tdt('v2') });
  assert.equal(
    h.configs.length,
    before,
    'prewarm cannot replace active CTC recognizer',
  );
  h.send({
    type: 'transcribe',
    id: 'overlap',
    audioFile: 'test.wav',
    ...tdt('v2'),
  });
  assert.equal(h.messages.at(-1).message, 'ASR worker is busy');
  h.resolve();
  await settle();
  const result = h.messages.find((m) => m.id === 'active' && m.type === 'done');
  const completedDetail = h.messages
    .filter((m) => m.id === 'active' && m.type === 'activity')
    .at(-1).detail;
  assert.equal(completedDetail.processedSeconds, 0.032);
  assert.deepEqual(completedDetail.units, []);
  assert.deepEqual(result.segments, [
    { start: 0, end: 0.032, text: 'recognized text' },
  ]);

  h.send({
    type: 'transcribe',
    id: 'cancel',
    audioFile: 'test.wav',
    ...tdt('v2'),
  });
  h.send({ type: 'cancel', id: 'cancel' });
  h.resolve();
  await settle();
  assert.equal(h.messages.at(-1).code, 'cancelled');
  assert.ok(!h.messages.some((m) => m.id === 'cancel' && m.type === 'done'));

  h.send({ type: 'transcribe', id: 'failure', audioFile: 'test.wav', ...ctc });
  h.reject();
  await settle();
  assert.match(h.messages.at(-1).message, /decode failed/);
  h.send({
    type: 'transcribe',
    id: 'missing',
    audioFile: 'missing.wav',
    ...ctc,
  });
  await settle();
  assert.match(h.messages.at(-1).message, /missing audio/);
  h.send({
    type: 'transcribe',
    id: 'retry',
    audioFile: 'test.wav',
    ...tdt('v3'),
  });
  h.resolve();
  await settle();
  assert.equal(h.messages.at(-1).type, 'done');
  assert.equal(h.messages.at(-1).id, 'retry');
  console.log(
    'sherpa worker: TDT/CTC configuration, caching, prewarm, cancellation and recovery passed',
  );

  await verifyWavIoIntegration();
  console.log(
    'sherpa worker: wav-io integration (JS read for non-ASCII paths, loud writeWave failures) passed',
  );
}

/**
 * Windows + 非 ASCII 路径上原生 readWave 打不开、writeWave 返回 false。
 * worker 经 wav-io 读写：该路径走 JS，writeWave 失败变成 error 消息而不是悄悄缺产物。
 */
async function verifyWavIoIntegration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-worker-wav-'));
  const previous = process.env.SMARTSUB_FORCE_JS_WAV;
  try {
    const cjkDir = path.join(dir, '中文用户-测试');
    fs.mkdirSync(cjkDir);
    const speech = path.join(cjkDir, 'speech.wav');
    fs.writeFileSync(
      speech,
      wavIo.encodeWavPcm16(new Float32Array(2048).fill(0.1), 16000),
    );
    const nativeReads = [];
    const vadParams = {
      vad_threshold: 0.5,
      vad_min_speech_duration_ms: 250,
      vad_min_silence_duration_ms: 100,
      vad_max_speech_duration_s: 0,
    };

    // 强制走 JS 路径（等价于 win32 + 非 ASCII 路径）：原生 readWave 不应被调用
    process.env.SMARTSUB_FORCE_JS_WAV = '1';
    const js = harness({
      readWave: (file) => {
        nativeReads.push(file);
        throw new Error('native readWave must not be used for this path');
      },
    });
    js.send({
      type: 'detectSpeech',
      id: 'cjk-detect',
      audioFile: speech,
      vadModel: '/vad.onnx',
      params: vadParams,
    });
    await settle();
    const detected = js.messages.find((m) => m.id === 'cjk-detect');
    assert.equal(detected.type, 'done', JSON.stringify(detected));
    assert.ok(detected.segments.length >= 1);
    assert.deepEqual(nativeReads, []);

    // JS 路径写出的 denoise 结果是合法 wav
    const denoised = path.join(cjkDir, 'denoised.wav');
    js.send({
      type: 'denoise',
      id: 'cjk-denoise',
      audioFile: speech,
      denoiseModel: '/gtcrn.onnx',
      outFile: denoised,
    });
    assert.equal(js.messages.at(-1).type, 'done');
    assert.equal(wavIo.decodeWav(fs.readFileSync(denoised)).sampleRate, 16000);

    // 读不了的音频：error 带原因，不是静默
    js.send({
      type: 'detectSpeech',
      id: 'cjk-missing',
      audioFile: path.join(cjkDir, 'missing.wav'),
      vadModel: '/vad.onnx',
      params: vadParams,
    });
    await settle();
    assert.match(
      js.messages.find((m) => m.id === 'cjk-missing').message,
      /Failed to read .*missing\.wav.*ENOENT/,
    );

    // 原生路径：writeWave 返回 false 必须变成 error，而不是继续报 done
    if (previous === undefined) delete process.env.SMARTSUB_FORCE_JS_WAV;
    else process.env.SMARTSUB_FORCE_JS_WAV = previous;
    const native = harness({ writeWave: () => false });
    native.send({
      type: 'denoise',
      id: 'native-denoise',
      audioFile: 'in.wav',
      denoiseModel: '/gtcrn.onnx',
      outFile: 'out.wav',
    });
    assert.equal(native.messages.at(-1).type, 'error');
    assert.match(native.messages.at(-1).message, /Failed to write 'out\.wav'/);
  } finally {
    if (previous === undefined) delete process.env.SMARTSUB_FORCE_JS_WAV;
    else process.env.SMARTSUB_FORCE_JS_WAV = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
