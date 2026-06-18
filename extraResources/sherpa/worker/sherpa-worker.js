'use strict';
// sherpa-onnx 转写 worker（worker_threads，纯 JS，不经 webpack）。
// 读 wav → silero VAD 分段 → 逐段 decodeAsync → 回报 progress/done/error。
// 原生库经 vendor/addon.js 从 SHERPA_ONNX_LIB_DIR dlopen（由主进程注入 env）。
const path = require('path');
const { parentPort } = require('worker_threads');

const sherpa = require(path.join(__dirname, '..', 'vendor', 'sherpa-onnx.js'));

const SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;

let recognizer = null;
let vad = null;
let cacheKey = '';
const cancelled = new Set();

function buildKey(req) {
  if (req.modelType === 'qwen3_asr') {
    const q = req.qwen || {};
    return [
      'qwen3_asr',
      q.encoder,
      q.decoder,
      req.params.num_threads,
      req.params.provider,
      req.params.max_total_len,
      req.params.max_new_tokens,
      req.params.temperature,
      req.params.top_p,
      req.params.seed,
    ].join('|');
  }
  return [
    req.modelType,
    req.asrModel,
    req.tokens,
    req.params.num_threads,
    req.params.language,
    req.params.use_itn,
  ].join('|');
}

// 与 main/helpers/sherpaOnnx/sherpaConfig.ts 等价（worker 不经 webpack，故内联）。
// 二者必须保持一致：sherpaConfig.ts 的纯逻辑已被 test:engines 覆盖。
function buildVadConfig(vadModel, p) {
  const UNLIMITED = 100000;
  return {
    sileroVad: {
      model: vadModel,
      threshold: p.vad_threshold,
      minSpeechDuration: p.vad_min_speech_duration_ms / 1000,
      minSilenceDuration: p.vad_min_silence_duration_ms / 1000,
      windowSize: VAD_WINDOW_SIZE,
      maxSpeechDuration:
        p.vad_max_speech_duration_s > 0
          ? p.vad_max_speech_duration_s
          : UNLIMITED,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  };
}

function buildRecognizerConfig(modelType, asrModel, tokens, p) {
  const modelConfig = {
    tokens,
    numThreads: p.num_threads,
    provider: p.provider,
    debug: 0,
  };
  if (modelType === 'paraformer') {
    modelConfig.paraformer = { model: asrModel };
  } else {
    modelConfig.senseVoice = {
      model: asrModel,
      language: p.language === 'auto' ? '' : p.language,
      useInverseTextNormalization: p.use_itn ? 1 : 0,
    };
  }
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig,
  };
}

// Qwen3-ASR：四件套映射到 qwen3Asr 块。原生绑定先 memset(0) 再覆盖存在的键，
// 故每个数值字段都必须显式给值，否则 maxTotalLen/maxNewTokens 等会变 0 导致解码失败。
function buildQwenRecognizerConfig(q, p) {
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      qwen3Asr: {
        convFrontend: q.convFrontend,
        encoder: q.encoder,
        decoder: q.decoder,
        tokenizer: q.tokenizer,
        maxTotalLen: p.max_total_len,
        maxNewTokens: p.max_new_tokens,
        temperature: p.temperature,
        topP: p.top_p,
        seed: p.seed,
      },
      tokens: '',
      numThreads: p.num_threads,
      provider: p.provider,
      debug: 0,
    },
  };
}

function ensureLoaded(req) {
  const key = buildKey(req);
  if (recognizer && key === cacheKey) return;
  const config =
    req.modelType === 'qwen3_asr'
      ? buildQwenRecognizerConfig(req.qwen, req.params)
      : buildRecognizerConfig(
          req.modelType,
          req.asrModel,
          req.tokens,
          req.params,
        );
  recognizer = new sherpa.OfflineRecognizer(config);
  vad = new sherpa.Vad(buildVadConfig(req.vadModel, req.params), 60);
  cacheKey = key;
}

function postCancelled(id) {
  cancelled.delete(id);
  parentPort.postMessage({
    type: 'error',
    id,
    code: 'cancelled',
    message: 'cancelled',
  });
}

async function transcribe(req) {
  ensureLoaded(req);
  vad.reset();
  // Electron worker 下必须 enableExternalBuffer=false（否则 readWave/vad.front 抛错）。
  const wave = sherpa.readWave(req.audioFile, false);
  const samples = wave.samples;
  const total = samples.length;
  const segments = [];
  let lastPercent = -1;

  const drain = async () => {
    while (!vad.isEmpty()) {
      if (cancelled.has(req.id)) return;
      const seg = vad.front(false); // enableExternalBuffer=false
      vad.pop();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: seg.samples, sampleRate: SAMPLE_RATE });
      const r = await recognizer.decodeAsync(stream);
      const start = seg.start / SAMPLE_RATE;
      const end = (seg.start + seg.samples.length) / SAMPLE_RATE;
      const text = r && r.text ? r.text.trim() : '';
      if (text) segments.push({ start, end, text });
    }
  };

  for (let i = 0; i < total; i += VAD_WINDOW_SIZE) {
    if (cancelled.has(req.id)) return postCancelled(req.id);
    vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW_SIZE));
    await drain();
    const pct = total > 0 ? Math.min(99, Math.round((i / total) * 100)) : 99;
    if (pct !== lastPercent) {
      lastPercent = pct;
      parentPort.postMessage({ type: 'progress', id: req.id, percent: pct });
    }
  }

  vad.flush();
  await drain();
  if (cancelled.has(req.id)) return postCancelled(req.id);
  cancelled.delete(req.id);
  parentPort.postMessage({ type: 'done', id: req.id, segments });
}

parentPort.on('message', (req) => {
  if (req.type === 'load') {
    try {
      ensureLoaded(req);
      parentPort.postMessage({ type: 'ready' });
    } catch (e) {
      parentPort.postMessage({ type: 'error', id: 'load', message: String(e) });
    }
    return;
  }
  if (req.type === 'cancel') {
    cancelled.add(req.id);
    return;
  }
  if (req.type === 'transcribe') {
    transcribe(req).catch((e) =>
      parentPort.postMessage({ type: 'error', id: req.id, message: String(e) }),
    );
    return;
  }
});
