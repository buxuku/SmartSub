'use strict';
/**
 * sherpa-onnx 用例脚本（探针 sherpa-case.cjs 与验证 verify-sherpa-case.cjs）共用的小工具。
 */
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 16000;
const WINDOW = 512;

const message = (e) => String((e && e.message) || e);

/** 打印 `RESULT:<json>`；回调里再退出，保证管道里的结果已写出（worker_threads 用例否则会挂住进程）。 */
function emit(result) {
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`, () =>
    process.exit(0),
  );
}

/** 从 stdin 读 UTF-8 JSON（避免命令行参数的编码问题）。 */
function readPayload() {
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

function loadSherpa(repoRoot) {
  return require(
    path.join(repoRoot, 'extraResources', 'sherpa', 'vendor', 'sherpa-onnx.js'),
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

/** 用给定 VAD 模型路径创建 Silero VAD，喂入 wav（原生 readWave），统计语音段数。 */
function runVad(sherpa, model, audio) {
  const vad = new sherpa.Vad(vadConfig(model), 60);
  // 与 worker 一致：先 reset()，句柄为空时这里就会打印 `vad is nullptr`。
  vad.reset();
  const wave = sherpa.readWave(audio, false);
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

/** 与 sherpa-worker.js 的 denoise() 同一份配置。 */
function createDenoiser(sherpa, model) {
  return new sherpa.OfflineSpeechDenoiser({
    model: { gtcrn: { model }, numThreads: 1, debug: 0 },
  });
}

/**
 * 以 worker_threads 运行真实的 sherpa-worker.js 并发一个请求，等到 done / error。
 * （应用里同一份 worker 跑在 Electron utilityProcess，日志里的
 * `asr worker stderr: vad is nullptr` 即来自这里。）
 * 返回 { ok: true, message } 或 { ok: false, error }。
 */
function runWorker(repoRoot, request, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(
      path.join(
        repoRoot,
        'extraResources',
        'sherpa',
        'worker',
        'sherpa-worker.js',
      ),
    );
    const timer = setTimeout(
      () => resolve({ ok: false, error: 'worker timed out' }),
      timeoutMs,
    );
    worker.on('message', (msg) => {
      if (msg.type !== 'done' && msg.type !== 'error') return;
      clearTimeout(timer);
      resolve(
        msg.type === 'done'
          ? { ok: true, message: msg }
          : { ok: false, error: msg.message },
      );
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: message(e) });
    });
    worker.postMessage(request);
  });
}

/** detectSpeech 请求（与探针、验证共用同一组 VAD 参数）。 */
function detectSpeechRequest(audioFile, vadModel) {
  return {
    type: 'detectSpeech',
    id: 'probe',
    audioFile,
    vadModel,
    params: {
      vad_threshold: 0.5,
      vad_min_speech_duration_ms: 250,
      vad_min_silence_duration_ms: 100,
      vad_max_speech_duration_s: 0,
    },
  };
}

module.exports = {
  SAMPLE_RATE,
  createDenoiser,
  detectSpeechRequest,
  emit,
  loadSherpa,
  message,
  readPayload,
  runVad,
  runWorker,
};
