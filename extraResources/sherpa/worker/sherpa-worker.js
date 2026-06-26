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
let vadKey = '';
// 仅 VAD（不加载 ASR 识别器）——供内置 whisper.cpp 0-fork 时间轴贴齐取语音边界。
// 与 transcribe 的 vad 分开缓存：只要边界时不必被迫加载 ASR 模型。
let vadOnly = null;
let vadOnlyKey = '';
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
  if (req.modelType === 'fire_red_asr') {
    const f = req.fireRed || {};
    return [
      'fire_red_asr',
      f.encoder,
      f.decoder,
      req.tokens,
      req.params.num_threads,
      req.params.provider,
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
// VAD 缓存键：仅 VAD 模型 + 灵敏度参数。与 ASR 识别器键（buildKey）分开，
// 使「字幕效果档位」切换 VAD 灵敏度时只重建廉价的 VAD，不重载昂贵的 ASR 模型。
function buildVadKey(req) {
  const p = req.params;
  return [
    req.vadModel,
    p.vad_threshold,
    p.vad_min_speech_duration_ms,
    p.vad_min_silence_duration_ms,
    p.vad_max_speech_duration_s,
  ].join('|');
}

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

// FireRedASR-AED：encoder + decoder 两件套映射到 fireRedAsr 块，tokens.txt 走顶层 tokens
// （与 sense_voice/paraformer 同位，区别于 qwen 的 tokenizer 目录 + 空 tokens）。
function buildFireRedRecognizerConfig(f, tokens, p) {
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      fireRedAsr: {
        encoder: f.encoder,
        decoder: f.decoder,
      },
      tokens,
      numThreads: p.num_threads,
      provider: p.provider,
      debug: 0,
    },
  };
}

function ensureLoaded(req) {
  const key = buildKey(req);
  if (!recognizer || key !== cacheKey) {
    let config;
    if (req.modelType === 'qwen3_asr') {
      config = buildQwenRecognizerConfig(req.qwen, req.params);
    } else if (req.modelType === 'fire_red_asr') {
      config = buildFireRedRecognizerConfig(
        req.fireRed,
        req.tokens,
        req.params,
      );
    } else {
      config = buildRecognizerConfig(
        req.modelType,
        req.asrModel,
        req.tokens,
        req.params,
      );
    }
    recognizer = new sherpa.OfflineRecognizer(config);
    cacheKey = key;
  }
  // VAD 与识别器分开缓存：仅当 VAD 灵敏度参数变化时重建 VAD（如切换字幕效果档位），
  // 避免「同模型不同 VAD」复用 worker 时静默沿用旧 VAD 参数。
  const vKey = buildVadKey(req);
  if (!vad || vKey !== vadKey) {
    vad = new sherpa.Vad(buildVadConfig(req.vadModel, req.params), 60);
    vadKey = vKey;
  }
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

// 仅 VAD：缓存一个独立的 silero VAD 实例（避免每个文件重载 onnx），按 vadModel+参数 复用。
function ensureVadOnly(req) {
  const key = buildVadKey(req);
  if (vadOnly && key === vadOnlyKey) return vadOnly;
  vadOnly = new sherpa.Vad(buildVadConfig(req.vadModel, req.params), 60);
  vadOnlyKey = key;
  return vadOnly;
}

// 只跑 VAD 拿语音段 [{start,end}]（秒），不做 ASR。供 builtin 时间轴贴齐使用。
async function detectSpeech(req) {
  const v = ensureVadOnly(req);
  v.reset();
  // Electron worker 下 enableExternalBuffer=false（同 transcribe，否则 readWave/vad.front 抛错）。
  const wave = sherpa.readWave(req.audioFile, false);
  const samples = wave.samples;
  const total = samples.length;
  const segments = [];

  const drain = () => {
    while (!v.isEmpty()) {
      if (cancelled.has(req.id)) return;
      const seg = v.front(false);
      v.pop();
      const start = seg.start / SAMPLE_RATE;
      const end = (seg.start + seg.samples.length) / SAMPLE_RATE;
      segments.push({ start, end });
    }
  };

  for (let i = 0; i < total; i += VAD_WINDOW_SIZE) {
    if (cancelled.has(req.id)) return postCancelled(req.id);
    v.acceptWaveform(samples.subarray(i, i + VAD_WINDOW_SIZE));
    drain();
  }
  v.flush();
  drain();
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
  if (req.type === 'detectSpeech') {
    detectSpeech(req).catch((e) =>
      parentPort.postMessage({ type: 'error', id: req.id, message: String(e) }),
    );
    return;
  }
});
