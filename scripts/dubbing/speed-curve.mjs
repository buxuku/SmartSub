/**
 * Phase 0 PoC(任务 1.4):经由 tts-worker.js 的消息协议(load/synthesize/cancel)
 * 验证 kokoro 单句合成出 16-bit PCM wav,并实测 speed 参数的时长缩短曲线
 * (speed=1.2 是否真的缩短 ~17% → 决定对齐引擎第 1 层预控制的可信度)。
 *
 * 模型:node_modules/.cache/tts-smoke/kokoro-int8-multi-lang-v1_1
 * (旧探索缓存;若缺失,从 sherpa-onnx releases 的 kokoro-int8-multi-lang-v1_1.tar.bz2 解包放置)
 *
 * 用法: node scripts/dubbing/speed-curve.mjs
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

const modelDir = path.join(
  root,
  'node_modules',
  '.cache',
  'tts-smoke',
  'kokoro-int8-multi-lang-v1_1',
);
const modelFile = ['model.int8.onnx', 'model.onnx']
  .map((f) => path.join(modelDir, f))
  .find((f) => fs.existsSync(f));
if (!modelFile) {
  console.error(`kokoro model not found under ${modelDir}`);
  process.exit(1);
}

const model = {
  modelType: 'kokoro',
  model: modelFile,
  voices: path.join(modelDir, 'voices.bin'),
  tokens: path.join(modelDir, 'tokens.txt'),
  dataDir: path.join(modelDir, 'espeak-ng-data'),
  lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt']
    .map((f) => path.join(modelDir, f))
    .join(','),
  ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
    .map((f) => path.join(modelDir, f))
    .join(','),
  numThreads: 2,
};

const outDir = path.join(root, 'node_modules', '.cache', 'dubbing-poc');
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

// 中文测试句(zh 女声 sid=10)+ 英文测试句(sid=0),各扫一组 speed。
const ZH_TEXT = '大家好,欢迎收看本期节目,今天我们聊聊本地语音合成的时长控制。';
const EN_TEXT =
  'Welcome to the show. Today we talk about duration control in local speech synthesis.';
const SPEEDS = [1.0, 1.15, 1.2, 1.3, 1.5, 2.0];

const t0 = Date.now();
await call('load', { model });
console.log(`model loaded in ${Date.now() - t0}ms`);

async function sweep(label, text, sid) {
  console.log(`\n── ${label}(sid=${sid},${text.length} chars)──`);
  let base = 0;
  for (const speed of SPEEDS) {
    const outWavPath = path.join(outDir, `${label}-speed${speed}.wav`);
    const t = Date.now();
    const r = await call('synthesize', { model, text, sid, speed, outWavPath });
    const sec = r.durationMs / 1000;
    if (speed === 1.0) base = r.durationMs;
    const actualRatio = base ? (r.durationMs / base).toFixed(3) : '1.000';
    const expectRatio = (1 / speed).toFixed(3);
    console.log(
      `speed=${speed}  → ${sec.toFixed(2)}s  实际比=${actualRatio}  理论比(1/speed)=${expectRatio}  合成${Date.now() - t}ms  ${path.basename(outWavPath)}`,
    );
  }
  if (base) {
    console.log(
      `  基准(1.0x)时长 ${(base / 1000).toFixed(2)}s → 语速基准 ≈ ${(text.length / (base / 1000)).toFixed(1)} chars/s`,
    );
  }
}

await sweep('zh', ZH_TEXT, 10);
await sweep('en', EN_TEXT, 0);

console.log(`\nwav 输出目录: ${path.relative(root, outDir)}`);
await worker.terminate();
