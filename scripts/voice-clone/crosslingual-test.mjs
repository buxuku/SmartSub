/**
 * 跨语言克隆质量复现（用户反馈：英文视频克隆音色 → 中文合成不清楚/不完整）：
 * 同一段中文/英文文本,分别用「英文参考(demo.mp4)」与「中文参考(雷军)」合成,
 * 对比时长与可听性。用法: node scripts/voice-clone/crosslingual-test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
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

// 英文参考:demo.mp4 5.24s–13.54s(字幕 1–2 行,精确转写)
const REF_EN = {
  wav: path.join(outDir, 'demo-ref-en.wav'),
  text: "I'm going to talk to you about some stuff that's in this book of mine that I hope will resonate with other things",
};
// 中文参考:zipvoice 随包雷军样本
const REF_ZH = {
  wav: path.join(modelDir, 'test_wavs', 'leijun-1.wav'),
  text: '那还是三十六年前, 一九八七年. 我呢考上了武汉大学的计算机系.',
};

const ZH_TEXT =
  '我要和你谈谈我这本书里的一些东西,我希望这能与你已经听到的其他事情产生共鸣,我会尝试。';
const EN_TEXT =
  "I'm going to talk to you about some stuff in this book, and I hope it will resonate with other things you've already heard.";

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
  worker.postMessage({
    type: 'synthesize',
    id,
    model,
    sid: 0,
    speed: 1,
    ...payload,
  });
  return promise;
}

const cases = [
  ['en-ref__zh-text', REF_EN, ZH_TEXT],
  ['zh-ref__zh-text', REF_ZH, ZH_TEXT],
  ['en-ref__en-text', REF_EN, EN_TEXT],
];
for (const [label, ref, text] of cases) {
  const outWavPath = path.join(outDir, `x-${label}.wav`);
  const r = await synth({
    text,
    outWavPath,
    generationConfig: { refWavPath: ref.wav, refText: ref.text },
  });
  console.log(
    `${label}: ${(r.durationMs / 1000).toFixed(2)}s (${text.length} chars → 期望约 ${(text.length / (label.includes('zh-text') ? 4.1 : 14)).toFixed(1)}s) → ${path.basename(outWavPath)}`,
  );
}
console.log(`\nwav 目录: ${path.relative(root, outDir)}(请试听对比清晰度)`);
await worker.terminate();
