/**
 * 声音克隆 Phase 0 PoC:经由 tts-worker.js 的消息协议验证 zipvoice 零样本克隆
 * 在内置 sherpa-onnx native(v1.13.2)上的实际可用性:
 *   1. zipvoice 模型配置(encoder/decoder/vocoder)能否 createOfflineTts;
 *   2. generationConfig(referenceAudio/referenceText)经 WithConfig API 合成;
 *   3. RTF 实测(numSteps=4/8 对比)——批量配音性能的关键数据;
 *   4. speed 参数在克隆合成下的实际时长曲线(对齐引擎第 1 层可信度)。
 *
 * 模型:node_modules/.cache/tts-smoke/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia
 * vocoder:node_modules/.cache/tts-smoke/vocos_24khz.onnx
 * (缺失时从 sherpa-onnx releases 的 tts-models / vocoder-models 下载解包放置)
 *
 * 用法: node scripts/voice-clone/zipvoice-poc.mjs
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
const libDir = path.join(
  root,
  'extraResources',
  'sherpa',
  'native',
  platformKey,
);
const workerFile = path.join(
  root,
  'extraResources',
  'sherpa',
  'worker',
  'tts-worker.js',
);

const smokeDir = path.join(root, 'node_modules', '.cache', 'tts-smoke');
const modelDir = path.join(
  smokeDir,
  'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
);
const vocoder = path.join(smokeDir, 'vocos_24khz.onnx');

for (const f of [
  path.join(modelDir, 'encoder.int8.onnx'),
  path.join(modelDir, 'decoder.int8.onnx'),
  path.join(modelDir, 'tokens.txt'),
  vocoder,
]) {
  if (!fs.existsSync(f)) {
    console.error(`missing model file: ${f}`);
    process.exit(1);
  }
}

const model = {
  modelType: 'zipvoice',
  encoder: path.join(modelDir, 'encoder.int8.onnx'),
  decoder: path.join(modelDir, 'decoder.int8.onnx'),
  vocoder,
  tokens: path.join(modelDir, 'tokens.txt'),
  dataDir: path.join(modelDir, 'espeak-ng-data'),
  lexicon: path.join(modelDir, 'lexicon.txt'),
  numThreads: 4,
};

// 官方随包参考音频(雷军 ~9s)+ 精确转写。
const refWavPath = path.join(modelDir, 'test_wavs', 'leijun-1.wav');
const refText = '那还是三十六年前, 一九八七年. 我呢考上了武汉大学的计算机系.';

const outDir = path.join(root, 'node_modules', '.cache', 'voice-clone-poc');
fs.mkdirSync(outDir, { recursive: true });

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
  if (msg.type === 'ready') {
    pending.get('load')?.resolve(msg);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'done') p.resolve(msg);
  else p.reject(new Error(msg.message));
});
worker.on('error', (e) => {
  console.error('worker error:', e);
  process.exit(1);
});

function call(type, payload) {
  const id = type === 'load' ? 'load' : `s${++seq}`;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  worker.postMessage({ type, id, ...payload });
  return promise;
}

const ZH_TEXT = '大家好,欢迎收看本期节目,今天我们聊聊声音克隆的效果。';
const EN_TEXT = 'Hello everyone, welcome to the show about voice cloning.';

const t0 = Date.now();
await call('load', { model });
console.log(`zipvoice model loaded in ${Date.now() - t0}ms`);

async function synth(label, text, { speed = 1, numSteps = 4 } = {}) {
  const outWavPath = path.join(outDir, `${label}.wav`);
  const t = Date.now();
  const r = await call('synthesize', {
    model,
    text,
    sid: 0,
    speed,
    outWavPath,
    generationConfig: { refWavPath, refText, numSteps },
  });
  const elapsed = Date.now() - t;
  const rtf = elapsed / r.durationMs;
  console.log(
    `${label}: 音频 ${(r.durationMs / 1000).toFixed(2)}s 合成 ${(elapsed / 1000).toFixed(2)}s RTF=${rtf.toFixed(2)} sr=${r.sampleRate} → ${path.basename(outWavPath)}`,
  );
  return r;
}

console.log('\n── numSteps 质量/速度权衡 ──');
await synth('zh-steps4', ZH_TEXT, { numSteps: 4 });
await synth('zh-steps4-warm', ZH_TEXT, { numSteps: 4 }); // 二跑(缓存热)
await synth('zh-steps8', ZH_TEXT, { numSteps: 8 });
await synth('en-steps4', EN_TEXT, { numSteps: 4 });

console.log('\n── speed 曲线(克隆合成)──');
let base = 0;
for (const speed of [1.0, 1.15, 1.3, 1.5]) {
  const r = await synth(`zh-speed${speed}`, ZH_TEXT, { speed });
  if (speed === 1.0) base = r.durationMs;
  else if (base) {
    console.log(
      `  speed=${speed} 实际比=${(r.durationMs / base).toFixed(3)} 理论比=${(1 / speed).toFixed(3)}`,
    );
  }
}

console.log('\n── 短文本(吞音风险检查)──');
await synth('zh-short', '好的。', { numSteps: 4 });

console.log(`\nwav 输出目录: ${path.relative(root, outDir)}`);
await worker.terminate();
