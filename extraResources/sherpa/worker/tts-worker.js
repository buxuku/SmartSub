'use strict';
// sherpa-onnx TTS worker（worker_threads，纯 JS，不经 webpack）。
// 与 ASR 的 sherpa-worker.js 同形制但独立实例（互不抢占、退出互不影响）。
// 消息协议：load / synthesize / cancel / dispose。
// 模型实例按参数缓存（tts-config.js 的 cacheKey）；合成结果写 16-bit PCM wav。
const path = require('path');
const { parentPort } = require('worker_threads');

const sherpa = require(path.join(__dirname, '..', 'vendor', 'sherpa-onnx.js'));
const { buildTtsConfig, buildTtsCacheKey, clampSpeed } = require(
  path.join(__dirname, 'tts-config.js'),
);

let tts = null;
let cacheKey = '';
const cancelled = new Set();

function ensureLoaded(req) {
  const key = buildTtsCacheKey(req.model);
  if (tts && key === cacheKey) return;
  tts = new sherpa.OfflineTts(buildTtsConfig(req.model));
  cacheKey = key;
}

function postError(id, message, code) {
  const msg = { type: 'error', id, message: String(message) };
  if (code) msg.code = code;
  parentPort.postMessage(msg);
}

async function synthesize(req) {
  ensureLoaded(req);
  if (cancelled.has(req.id)) {
    cancelled.delete(req.id);
    return postError(req.id, 'cancelled', 'cancelled');
  }
  const sid = Number.isFinite(Number(req.sid)) ? Number(req.sid) : 0;
  const speed = clampSpeed(req.speed);

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
  parentPort.postMessage({
    type: 'done',
    id: req.id,
    sampleRate: audio.sampleRate,
    numSamples: audio.samples.length,
    durationMs: Math.round((audio.samples.length / audio.sampleRate) * 1000),
  });
}

parentPort.on('message', (req) => {
  if (req.type === 'load') {
    try {
      ensureLoaded(req);
      parentPort.postMessage({
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
    return;
  }
});
