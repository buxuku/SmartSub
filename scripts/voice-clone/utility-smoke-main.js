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

  // ── 阶段 4：双进程并行（进程池语义）——墙钟应显著小于串行和 ──
  const TEXT_A = '并行合成的第一句话，用来测量墙钟时间。';
  const TEXT_B = '并行合成的第二句话，两个进程同时推理。';
  // 串行基线（同一进程先后两句）。
  let t = Date.now();
  await synthOnce(w2, 's4a', TEXT_A, path.join(outDir, 'utility-serial-a.wav'));
  await synthOnce(w2, 's4b', TEXT_B, path.join(outDir, 'utility-serial-b.wav'));
  const serialMs = Date.now() - t;
  // 双进程并行（w3 预热后计时）。
  const w3 = forkWorker();
  await synthOnce(w3, 'warm', '预热。', path.join(outDir, 'utility-warm.wav'));
  t = Date.now();
  const [p1, p2] = await Promise.all([
    synthOnce(w2, 's5a', TEXT_A, path.join(outDir, 'utility-par-a.wav')),
    synthOnce(w3, 's5b', TEXT_B, path.join(outDir, 'utility-par-b.wav')),
  ]);
  const parallelMs = Date.now() - t;
  console.log(
    `阶段4 串行 ${serialMs}ms vs 双进程并行 ${parallelMs}ms（音频 ${p1.durationMs}/${p2.durationMs}ms）`,
  );
  if (parallelMs > serialMs * 0.75) {
    console.error('并行未获得预期收益（>75% 串行耗时）');
    w2.kill();
    w3.kill();
    app.exit(1);
    return;
  }
  w2.kill();
  w3.kill();

  console.log('\nutility-process smoke OK');
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error(e);
    app.exit(1);
  }),
);
