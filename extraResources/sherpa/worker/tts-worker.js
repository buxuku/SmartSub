'use strict';
// sherpa-onnx TTS worker（纯 JS，不经 webpack）。
// 与 ASR 的 sherpa-worker.js 同形制但独立实例（互不抢占、退出互不影响）。
// 消息协议：load / synthesize / cancel / dispose。
// 模型实例按参数缓存（tts-config.js 的 cacheKey）；合成结果写 16-bit PCM wav。
const path = require('path');

// 通道双运行时适配：应用内跑 Electron utilityProcess（独立进程，native 崩溃
// 不带崩主进程；message 事件为 MessageEvent，取 .data），PoC/单测脚本跑纯
// node worker_threads（message 事件即消息本体）。协议本体两侧一致。
const channel = (() => {
  if (process.parentPort) {
    return {
      post: (msg) => process.parentPort.postMessage(msg),
      onMessage: (cb) => process.parentPort.on('message', (e) => cb(e.data)),
    };
  }
  const { parentPort } = require('worker_threads');
  return {
    post: (msg) => parentPort.postMessage(msg),
    onMessage: (cb) => parentPort.on('message', cb),
  };
})();

const sherpa = require(path.join(__dirname, '..', 'vendor', 'sherpa-onnx.js'));
const {
  buildTtsConfig,
  buildTtsCacheKey,
  clampSpeed,
  splitCloneText,
  cloneChunkLimit,
  normalizeChineseCloneText,
} = require(path.join(__dirname, 'tts-config.js'));

let tts = null;
let cacheKey = '';
const cancelled = new Set();

// 克隆参考音频缓存：refWavPath → {samples, sampleRate}。参考文件按音色目录
// 一次性生成后不可变，路径即缓存键；封顶防呆（正常会话只用到个位数音色）。
const refAudioCache = new Map();
const REF_CACHE_MAX = 8;

function getRefAudio(refWavPath) {
  const hit = refAudioCache.get(refWavPath);
  if (hit) return hit;
  // Electron worker 下 enableExternalBuffer=false（同 ASR worker readWave）。
  const wave = sherpa.readWave(refWavPath, false);
  if (refAudioCache.size >= REF_CACHE_MAX) {
    refAudioCache.delete(refAudioCache.keys().next().value);
  }
  refAudioCache.set(refWavPath, wave);
  return wave;
}

function ensureLoaded(req) {
  const key = buildTtsCacheKey(req.model);
  if (tts && key === cacheKey) return;
  tts = new sherpa.OfflineTts(buildTtsConfig(req.model));
  cacheKey = key;
}

function postError(id, message, code) {
  const msg = { type: 'error', id, message: String(message) };
  if (code) msg.code = code;
  channel.post(msg);
}

/** 克隆合成的块间停顿（拼接处自然过渡）。 */
const CLONE_CHUNK_GAP_MS = 100;

/**
 * 零样本克隆合成（zipvoice）：flow-matching 内存随（参考+目标）序列平方级
 * 增长,长文本单次生成会在 Electron 的 PartitionAlloc 下触发 onnxruntime
 * 大块分配 SIGTRAP(worker_threads 同进程,直接带崩应用)——按标点/上限切块
 * 逐块生成再拼接,块间取消即时生效。
 */
async function synthesizeClone(req, sid, speed) {
  const gc = req.generationConfig;
  const ref = getRefAudio(gc.refWavPath);
  const refSeconds = ref.samples.length / (ref.sampleRate || 1);
  // 中文数字归一化：zipvoice 无 ruleFsts，阿拉伯数字会被读成英文
  // （"2020年" → "twenty twenty 年"）；参考文本同步处理（与参考音频
  // 发音对齐）。
  const text = normalizeChineseCloneText(req.text);
  const chunks = splitCloneText(text, cloneChunkLimit(refSeconds));
  if (chunks.length === 0) {
    return postError(req.id, 'tts generated empty audio');
  }
  const generationConfig = {
    speed,
    referenceAudio: ref.samples,
    referenceSampleRate: ref.sampleRate,
    referenceText: normalizeChineseCloneText(String(gc.refText || '')),
    numSteps: Number.isFinite(Number(gc.numSteps)) ? Number(gc.numSteps) : 4,
    // 短行（一两个字）易吞音，官方建议合并短句下限。
    extra: { min_char_in_sentence: 10 },
  };

  const parts = [];
  let sampleRate = 0;
  let total = 0;
  for (const chunk of chunks) {
    if (cancelled.has(req.id)) {
      cancelled.delete(req.id);
      return postError(req.id, 'cancelled', 'cancelled');
    }
    const audio = await tts.generateAsync({
      text: chunk,
      sid,
      speed,
      enableExternalBuffer: false,
      generationConfig,
    });
    if (!audio || !audio.samples || audio.samples.length === 0) continue;
    sampleRate = audio.sampleRate;
    parts.push(audio.samples);
    total += audio.samples.length;
  }
  if (cancelled.has(req.id)) {
    cancelled.delete(req.id);
    return postError(req.id, 'cancelled', 'cancelled');
  }
  if (total === 0 || sampleRate === 0) {
    return postError(req.id, 'tts generated empty audio');
  }

  const gap = Math.round((CLONE_CHUNK_GAP_MS / 1000) * sampleRate);
  const samples = new Float32Array(total + gap * (parts.length - 1));
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    samples.set(parts[i], offset);
    offset += parts[i].length + (i < parts.length - 1 ? gap : 0);
  }

  sherpa.writeWave(req.outWavPath, { samples, sampleRate });
  channel.post({
    type: 'done',
    id: req.id,
    sampleRate,
    numSamples: samples.length,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
  });
}

async function synthesize(req) {
  ensureLoaded(req);
  if (cancelled.has(req.id)) {
    cancelled.delete(req.id);
    return postError(req.id, 'cancelled', 'cancelled');
  }
  const sid = Number.isFinite(Number(req.sid)) ? Number(req.sid) : 0;
  const speed = clampSpeed(req.speed);

  if (req.generationConfig && req.generationConfig.refWavPath) {
    return synthesizeClone(req, sid, speed);
  }

  // 不传 onProgress：其 TSFN 回调在 worker 线程按 chunk 分配 external ArrayBuffer,
  // 实测触发 v8 OOM 崩溃(darwin-arm64, v1.13.2)。取消语义降级为「句间生效」——
  // 单句合成秒级,管线取消在下一条 cue 前拦截,合同(不落半成品)不受影响。
  // enableExternalBuffer 必须显式 false：Electron 禁止 napi external buffer
  // (报 "External buffers are not allowed"),与 ASR worker 的 readWave/front 同因。
  const audio = await tts.generateAsync({
    text: req.text,
    sid,
    speed,
    enableExternalBuffer: false,
  });
  if (cancelled.has(req.id)) {
    cancelled.delete(req.id);
    return postError(req.id, 'cancelled', 'cancelled');
  }
  if (!audio || !audio.samples || audio.samples.length === 0) {
    return postError(req.id, 'tts generated empty audio');
  }

  sherpa.writeWave(req.outWavPath, {
    samples: audio.samples,
    sampleRate: audio.sampleRate,
  });
  channel.post({
    type: 'done',
    id: req.id,
    sampleRate: audio.sampleRate,
    numSamples: audio.samples.length,
    durationMs: Math.round((audio.samples.length / audio.sampleRate) * 1000),
  });
}

channel.onMessage((req) => {
  if (req.type === 'load') {
    try {
      ensureLoaded(req);
      channel.post({
        type: 'ready',
        numSpeakers: tts.numSpeakers,
        sampleRate: tts.sampleRate,
      });
    } catch (e) {
      postError('load', e);
    }
    return;
  }
  if (req.type === 'cancel') {
    cancelled.add(req.id);
    return;
  }
  if (req.type === 'synthesize') {
    synthesize(req).catch((e) => postError(req.id, e));
    return;
  }
  if (req.type === 'dispose') {
    tts = null;
    cacheKey = '';
    refAudioCache.clear();
    return;
  }
});
