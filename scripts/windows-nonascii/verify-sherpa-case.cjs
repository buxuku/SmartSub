'use strict';
/**
 * 单个 sherpa-onnx 修复验证用例（每个用例一个进程，见 lib.mjs 的 runCase）。
 * stdin 传入 UTF-8 JSON：{ repoRoot, kind, ... }；结果以 `RESULT:<json>` 打印到 stdout。
 *
 * 与探针（sherpa-case.cjs）不同，这里跑的是应用里的实现，而不是复现原生库的缺陷：
 *  - nativeSafePath.ts：随包 VAD / 降噪模型暂存到纯 ASCII 目录（SherpaFunasrRuntime 在
 *    把路径交给 worker 之前做的事）；
 *  - wav-io.js：worker 里 readWave / writeWave 对非 ASCII 路径改由 JS 读写。
 *
 * kind:
 *  - staged-vad       暂存 VAD 模型，用暂存路径创建 VAD 并统计语音段（音频用 ASCII 路径）
 *  - staged-denoiser  暂存降噪模型，用暂存路径创建降噪器
 *  - wav-roundtrip    wav-io 在非 ASCII 路径读写 wav，与 ASCII 路径上的原生实现对拍
 *  - worker-detect-speech  暂存 VAD 模型 + 真实 sherpa-worker.js 对非 ASCII 音频做 detectSpeech
 *  - worker-denoise   暂存降噪模型 + 真实 sherpa-worker.js 读写非 ASCII 路径的 wav
 */
const fs = require('node:fs');
const path = require('node:path');
const { requireRepoTs } = require('./ts-require.cjs');
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
const { ensureNativeSafeModelPath, hasNonAscii } = requireRepoTs(
  'main/helpers/sherpaOnnx/nativeSafePath.ts',
);
const wavIo = require(
  path.join(
    payload.repoRoot,
    'extraResources',
    'sherpa',
    'worker',
    'wav-io.js',
  ),
);

function sameBytes(a, b) {
  return Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
}

function maxAbsDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}

/** SherpaFunasrRuntime 交给 worker 之前对随包模型做的暂存，外加暂存结果的基本事实。 */
function stage(model) {
  const logs = [];
  const options = {
    userDataDir: payload.userDataDir,
    log: (text, level) => logs.push(`${level}: ${text}`),
  };
  const staged = ensureNativeSafeModelPath(model, options);
  return {
    staged,
    unchanged: staged === model,
    stagedAscii: !hasNonAscii(staged),
    identical: staged === model ? null : sameBytes(staged, model),
    logs,
  };
}

function sine(seconds) {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin(i / 20) * 0.3;
  }
  return samples;
}

function runWavRoundtrip(sherpa) {
  const wave = { samples: sine(1), sampleRate: SAMPLE_RATE };
  // 非 ASCII 路径（Windows 上走 JS 编码）与 ASCII 路径（走原生编码）写同一份数据
  wavIo.writeWave(sherpa, payload.nonAsciiOut, wave);
  wavIo.writeWave(sherpa, payload.asciiOut, wave);
  const backNonAscii = wavIo.readWave(sherpa, payload.nonAsciiOut, false);
  const backAscii = sherpa.readWave(payload.asciiOut, false);
  const speechNonAscii = wavIo.readWave(sherpa, payload.speechNonAscii, false);
  const speechAscii = sherpa.readWave(payload.speechAscii, false);

  // 写到不存在的目录必须是异常，不能再像原生 writeWave 那样悄悄返回 false
  let loudError = null;
  try {
    wavIo.writeWave(
      sherpa,
      path.join(path.dirname(payload.nonAsciiOut), 'no-such-dir', 'x.wav'),
      wave,
    );
  } catch (e) {
    loudError = message(e);
  }

  return {
    ok: true,
    bytesIdentical: sameBytes(payload.nonAsciiOut, payload.asciiOut),
    fileSize: fs.statSync(payload.nonAsciiOut).size,
    roundTripSamples: [backNonAscii.samples.length, backAscii.samples.length],
    roundTripMaxDiff: maxAbsDiff(backNonAscii.samples, backAscii.samples),
    roundTripSampleRate: backNonAscii.sampleRate,
    speechSamples: [speechNonAscii.samples.length, speechAscii.samples.length],
    speechMaxDiff: maxAbsDiff(speechNonAscii.samples, speechAscii.samples),
    loudError,
  };
}

async function runWorkerDetectSpeech() {
  const st = stage(payload.model);
  const r = await runWorker(
    payload.repoRoot,
    detectSpeechRequest(payload.audio, st.staged),
  );
  return r.ok
    ? { ok: true, ...st, segments: (r.message.segments || []).length }
    : { ok: false, ...st, error: r.error };
}

async function runWorkerDenoise() {
  const st = stage(payload.model);
  const r = await runWorker(payload.repoRoot, {
    type: 'denoise',
    id: 'verify',
    audioFile: payload.audio,
    denoiseModel: st.staged,
    outFile: payload.outFile,
  });
  if (!r.ok) return { ok: false, ...st, error: r.error };
  const exists = fs.existsSync(payload.outFile);
  const sherpa = loadSherpa(payload.repoRoot);
  let samples = 0;
  if (exists) {
    samples = wavIo.readWave(sherpa, payload.outFile, false).samples.length;
  }
  return {
    ok: exists && samples > 0,
    ...st,
    exists,
    samples,
    sampleRate: r.message.sampleRate,
  };
}

async function main() {
  switch (payload.kind) {
    case 'staged-vad': {
      const st = stage(payload.model);
      const sherpa = loadSherpa(payload.repoRoot);
      emit({ ...st, ...runVad(sherpa, st.staged, payload.audio) });
      return;
    }
    case 'staged-denoiser': {
      const st = stage(payload.model);
      createDenoiser(loadSherpa(payload.repoRoot), st.staged);
      emit({ ok: true, ...st });
      return;
    }
    case 'wav-roundtrip':
      emit(runWavRoundtrip(loadSherpa(payload.repoRoot)));
      return;
    case 'worker-detect-speech':
      emit(await runWorkerDetectSpeech());
      return;
    case 'worker-denoise':
      emit(await runWorkerDenoise());
      return;
    default:
      throw new Error(`unknown kind: ${payload.kind}`);
  }
}

main().catch((e) => emit({ ok: false, error: message(e) }));
