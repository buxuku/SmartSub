/**
 * 跨语言克隆的 speed 补偿系数标定：英文参考 + 中文文本,扫 speed<1
 * 找到时长接近「中文参考基准(8.8s)」的补偿值。
 * 用法: node scripts/voice-clone/crosslingual-speed.mjs
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
const REF_EN = {
  wav: path.join(outDir, 'demo-ref-en.wav'),
  text: "I'm going to talk to you about some stuff that's in this book of mine that I hope will resonate with other things",
};
const ZH_TEXT =
  '我要和你谈谈我这本书里的一些东西,我希望这能与你已经听到的其他事情产生共鸣,我会尝试。';
const EN_SHORT = 'But I want to start with what I call the official dogma.';
const REF_ZH = {
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
function synth(payload) {
  const id = `s${++seq}`;
  const promise = new Promise((res, rej) =>
    pending.set(id, { resolve: res, reject: rej }),
  );
  worker.postMessage({ type: 'synthesize', id, model, sid: 0, ...payload });
  return promise;
}

console.log('── en-ref + zh-text 的 speed 扫描(基准: zh-ref 同文本 8.82s)──');
for (const speed of [1.0, 0.8, 0.7, 0.6, 0.5, 0.4]) {
  const r = await synth({
    text: ZH_TEXT,
    speed,
    outWavPath: path.join(outDir, `xs-zh-speed${speed}.wav`),
    generationConfig: { refWavPath: REF_EN.wav, refText: REF_EN.text },
  });
  console.log(`speed=${speed} → ${(r.durationMs / 1000).toFixed(2)}s`);
}
console.log('\n── 对照:zh-ref + en-text(反向错配)──');
for (const speed of [1.0, 0.7]) {
  const r = await synth({
    text: EN_SHORT,
    speed,
    outWavPath: path.join(outDir, `xs-en-speed${speed}.wav`),
    generationConfig: { refWavPath: REF_ZH.wav, refText: REF_ZH.text },
  });
  console.log(
    `speed=${speed} → ${(r.durationMs / 1000).toFixed(2)}s (${EN_SHORT.length} chars, 期望 ~${(EN_SHORT.length / 14).toFixed(1)}s)`,
  );
}
await worker.terminate();
