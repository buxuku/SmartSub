'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerPath = path.resolve(
  __dirname,
  '../extraResources/sherpa/worker/sherpa-worker.js',
);
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

function harness() {
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
      if (file === 'missing.wav') throw new Error('missing audio');
      return { samples: new Float32Array(512) };
    },
  };
  vm.runInNewContext(
    fs.readFileSync(workerPath, 'utf8'),
    {
      __dirname: path.dirname(workerPath),
      require: (id) => (id === 'path' ? path : sherpa),
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
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
