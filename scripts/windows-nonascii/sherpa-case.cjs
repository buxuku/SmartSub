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
 */
const fs = require('node:fs');
const {
  SAMPLE_RATE,
  createDenoiser,
  detectSpeechRequest,
  emit,
  loadSherpa,
  message,
  readPayload,
  runVad,
  runWorker,
} = require('./sherpa-common.cjs');

const payload = readPayload();

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

async function main() {
  if (payload.kind === 'worker-detect-speech') {
    const r = await runWorker(
      payload.repoRoot,
      detectSpeechRequest(payload.audio, payload.model),
    );
    emit(
      r.ok
        ? { ok: true, segments: (r.message.segments || []).length }
        : { ok: false, error: r.error },
    );
    return;
  }
  const sherpa = loadSherpa(payload.repoRoot);
  const runners = {
    vad: () => runVad(sherpa, payload.model, payload.audio),
    readWave: () => runReadWave(sherpa),
    writeWave: () => runWriteWave(sherpa),
    denoiser: () => {
      createDenoiser(sherpa, payload.model);
      return { ok: true };
    },
  };
  const run = runners[payload.kind];
  if (!run) throw new Error(`unknown kind: ${payload.kind}`);
  emit(run());
}

main().catch((e) => emit({ ok: false, error: message(e) }));
