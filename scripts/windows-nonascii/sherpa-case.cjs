'use strict';
/**
 * 单个 sherpa-onnx 探针用例（每个用例一个进程，见 lib.mjs 的 runCase）。
 * stdin 传入 UTF-8 JSON：{ repoRoot, kind, ... }；结果以 `RESULT:<json>` 打印到 stdout。
 *
 * kind:
 *  - vad                   用给定模型路径创建 Silero VAD，喂入语音，统计语音段数
 *  - readWave / writeWave  原生读写 wav
 *  - denoiser              用给定模型路径创建 gtcrn 降噪器
 *  - worker-detect-speech  以 worker_threads 运行真实的 sherpa-worker.js，发 detectSpeech 请求
 *                          （应用里同一份 worker 跑在 Electron utilityProcess，日志里的
 *                          `asr worker stderr: vad is nullptr` 即来自这里）
 */
const fs = require('node:fs');
const path = require('node:path');

const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const SAMPLE_RATE = 16000;
const WINDOW = 512;

function emit(result) {
  // 回调里再退出，保证管道里的结果已写出；worker_threads 用例否则会让进程挂住。
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`, () =>
    process.exit(0),
  );
}

const message = (e) => String((e && e.message) || e);

function loadSherpa() {
  return require(
    path.join(
      payload.repoRoot,
      'extraResources',
      'sherpa',
      'vendor',
      'sherpa-onnx.js',
    ),
  );
}

function vadConfig(model) {
  return {
    sileroVad: {
      model,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.1,
      windowSize: WINDOW,
      maxSpeechDuration: 100000,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  };
}

function runVad(sherpa) {
  const vad = new sherpa.Vad(vadConfig(payload.model), 60);
  // 与 worker 一致：先 reset()，句柄为空时这里就会打印 `vad is nullptr`。
  vad.reset();
  const wave = sherpa.readWave(payload.audio, false);
  let segments = 0;
  const drain = () => {
    while (!vad.isEmpty()) {
      vad.front(false);
      vad.pop();
      segments += 1;
    }
  };
  for (let i = 0; i < wave.samples.length; i += WINDOW) {
    vad.acceptWaveform(wave.samples.subarray(i, i + WINDOW));
    drain();
  }
  vad.flush();
  drain();
  return { ok: true, segments, seconds: wave.samples.length / SAMPLE_RATE };
}

function runReadWave(sherpa) {
  const wave = sherpa.readWave(payload.file, false);
  return {
    ok: true,
    samples: wave.samples.length,
    sampleRate: wave.sampleRate,
  };
}

function runWriteWave(sherpa) {
  const samples = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin(i / 20) * 0.3;
  }
  // 原生 writeWave 失败时只返回 false、不抛错。
  const returned = sherpa.writeWave(payload.file, {
    samples,
    sampleRate: SAMPLE_RATE,
  });
  const exists = fs.existsSync(payload.file);
  return {
    ok: returned === true && exists,
    returned,
    exists,
    size: exists ? fs.statSync(payload.file).size : 0,
  };
}

function runDenoiser(sherpa) {
  // 与 sherpa-worker.js 的 denoise() 同一份配置。
  new sherpa.OfflineSpeechDenoiser({
    model: { gtcrn: { model: payload.model }, numThreads: 1, debug: 0 },
  });
  return { ok: true };
}

function runWorkerDetectSpeech() {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(
    path.join(
      payload.repoRoot,
      'extraResources',
      'sherpa',
      'worker',
      'sherpa-worker.js',
    ),
  );
  const timer = setTimeout(
    () => emit({ ok: false, error: 'worker timed out' }),
    90000,
  );
  worker.on('message', (msg) => {
    if (msg.type !== 'done' && msg.type !== 'error') return;
    clearTimeout(timer);
    emit(
      msg.type === 'done'
        ? { ok: true, segments: (msg.segments || []).length }
        : { ok: false, error: msg.message },
    );
  });
  worker.on('error', (e) => emit({ ok: false, error: message(e) }));
  worker.postMessage({
    type: 'detectSpeech',
    id: 'probe',
    audioFile: payload.audio,
    vadModel: payload.model,
    params: {
      vad_threshold: 0.5,
      vad_min_speech_duration_ms: 250,
      vad_min_silence_duration_ms: 100,
      vad_max_speech_duration_s: 0,
    },
  });
}

function main() {
  if (payload.kind === 'worker-detect-speech') {
    runWorkerDetectSpeech();
    return;
  }
  const sherpa = loadSherpa();
  const runners = {
    vad: runVad,
    readWave: runReadWave,
    writeWave: runWriteWave,
    denoiser: runDenoiser,
  };
  const run = runners[payload.kind];
  if (!run) throw new Error(`unknown kind: ${payload.kind}`);
  emit(run(sherpa));
}

try {
  main();
} catch (e) {
  emit({ ok: false, error: message(e) });
}
