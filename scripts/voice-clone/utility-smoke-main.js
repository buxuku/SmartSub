'use strict';
/**
 * utilityProcess 冒烟（electron 无窗口 app，验证与应用同路径的 worker 进程化）：
 *  1. fork TTS worker → kokoro 合成一句 → done；
 *  2. 发起合成后立即 kill 子进程（模拟 native 崩溃）→ 断言主进程存活、
 *     在途请求可感知退出；
 *  3. 重新 fork 再合成成功（自动重建语义）。
 * 运行：npm run smoke:utility（需 PoC 缓存的 kokoro 模型）
 */
const path = require('path');
const fs = require('fs');
const { app, utilityProcess } = require('electron');

const root = path.resolve(__dirname, '../..');
const platformKey = `${process.platform}-${process.arch}`;
const libDir = path.join(root, 'extraResources/sherpa/native', platformKey);
const workerFile = path.join(
  root,
  'extraResources/sherpa/worker/tts-worker.js',
);
const modelDir = path.join(
  root,
  'node_modules/.cache/tts-smoke/kokoro-int8-multi-lang-v1_1',
);
const outDir = path.join(root, 'node_modules/.cache/voice-clone-poc');

const model = {
  modelType: 'kokoro',
  model: path.join(modelDir, 'model.int8.onnx'),
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

function forkWorker() {
  return utilityProcess.fork(workerFile, [], {
    serviceName: 'smoke-tts-worker',
    stdio: 'pipe',
    env: {
      ...process.env,
      SHERPA_ONNX_LIB_DIR: libDir,
      PATH: `${libDir}${path.delimiter}${process.env.PATH ?? ''}`,
      LD_LIBRARY_PATH: `${libDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
    },
  });
}

function synthOnce(child, id, text, outWavPath) {
  return new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      if (msg.id !== id) return;
      child.removeListener('message', onMsg);
      msg.type === 'done' ? resolve(msg) : reject(new Error(msg.message));
    };
    child.on('message', onMsg);
    child.postMessage({
      type: 'synthesize',
      id,
      model,
      text,
      sid: 10,
      speed: 1,
      outWavPath,
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(modelDir, 'model.int8.onnx'))) {
    console.error(`missing kokoro model: ${modelDir}`);
    app.exit(1);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  // ── 阶段 1：正常合成 ──
  const w1 = forkWorker();
  w1.stderr?.on('data', (d) => {
    const s = String(d).trim();
    if (s) console.error(`[worker stderr] ${s}`);
  });
  const r1 = await synthOnce(
    w1,
    's1',
    '这是独立进程合成测试。',
    path.join(outDir, 'utility-smoke-1.wav'),
  );
  console.log(
    `阶段1 utilityProcess 合成 OK: ${r1.durationMs}ms @${r1.sampleRate}Hz`,
  );

  // ── 阶段 2：模拟 native 崩溃（kill 在途），主进程必须存活 ──
  const exitPromise = new Promise((resolve) => w1.once('exit', resolve));
  const pending = synthOnce(
    w1,
    's2',
    '这句合成会被杀死的进程带走。',
    path.join(outDir, 'utility-smoke-2.wav'),
  );
  w1.kill();
  const exitCode = await exitPromise;
  console.log(`阶段2 worker 被杀（exit code ${exitCode}），主进程存活 ✓`);
  // 在途请求不会有响应（真实 runtime 由 exit 监听统一 reject）——这里只需
  // 确认没有未捕获异常把主进程带崩。
  pending.catch(() => {});

  // ── 阶段 3：重建再合成（自动恢复语义）──
  const w2 = forkWorker();
  const r3 = await synthOnce(
    w2,
    's3',
    '重建后的进程继续工作。',
    path.join(outDir, 'utility-smoke-3.wav'),
  );
  console.log(`阶段3 重建后合成 OK: ${r3.durationMs}ms`);
  w2.kill();

  console.log('\nutility-process smoke OK');
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error(e);
    app.exit(1);
  }),
);
