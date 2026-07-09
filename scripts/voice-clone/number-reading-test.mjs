/**
 * 数字读法验证：含数字的中文句(归一化在 worker 内自动生效)用中文参考合成,
 * 试听确认 "2020年" 读作 "二零二零年" 而非英文。
 * 用法: node scripts/voice-clone/number-reading-test.mjs
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const platformKey = `${process.platform}-${process.arch}`;
const libDir = path.join(root, 'extraResources/sherpa/native', platformKey);
const workerFile = path.join(
  root,
  'extraResources/sherpa/worker/tts-worker.js',
);
const smokeDir = path.join(root, 'node_modules/.cache/tts-smoke');
const modelDir = path.join(
  smokeDir,
  'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
);
const outDir = path.join(root, 'node_modules/.cache/voice-clone-poc');

const model = {
  modelType: 'zipvoice',
  encoder: path.join(modelDir, 'encoder.int8.onnx'),
  decoder: path.join(modelDir, 'decoder.int8.onnx'),
  vocoder: path.join(smokeDir, 'vocos_24khz.onnx'),
  tokens: path.join(modelDir, 'tokens.txt'),
  dataDir: path.join(modelDir, 'espeak-ng-data'),
  lexicon: path.join(modelDir, 'lexicon.txt'),
  numThreads: 4,
};
const REF = {
  wav: path.join(modelDir, 'test_wavs', 'leijun-1.wav'),
  text: '那还是三十六年前, 一九八七年. 我呢考上了武汉大学的计算机系.',
};

const worker = new Worker(workerFile, {
  env: {
    ...process.env,
    SHERPA_ONNX_LIB_DIR: libDir,
    PATH: `${libDir}${path.delimiter}${process.env.PATH ?? ''}`,
    LD_LIBRARY_PATH: `${libDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
  },
});
const pending = new Map();
let seq = 0;
worker.on('message', (msg) => {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.type === 'done' ? p.resolve(msg) : p.reject(new Error(msg.message));
});
worker.on('error', (e) => {
  console.error(e);
  process.exit(1);
});
function synth(text, outName) {
  const id = `s${++seq}`;
  const promise = new Promise((res, rej) =>
    pending.set(id, { resolve: res, reject: rej }),
  );
  worker.postMessage({
    type: 'synthesize',
    id,
    model,
    sid: 0,
    speed: 1,
    text,
    outWavPath: path.join(outDir, outName),
    generationConfig: { refWavPath: REF.wav, refText: REF.text },
  });
  return promise;
}

const cases = [
  ['今天是2020年6月25日，气温23.5度。', 'num-date.wav'],
  ['第3章讲了80%的核心内容，共215个例子。', 'num-percent.wav'],
];
for (const [text, out] of cases) {
  const r = await synth(text, out);
  console.log(`"${text}" → ${(r.durationMs / 1000).toFixed(2)}s → ${out}`);
}
console.log(
  `\n请试听 ${path.relative(root, outDir)}/num-*.wav 确认数字为中文读法`,
);
await worker.terminate();
