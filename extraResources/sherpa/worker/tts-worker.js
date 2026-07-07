'use strict';
// sherpa-onnx TTS worker（worker_threads，纯 JS，不经 webpack）。
// 逐句合成：文本 + sid + speed → 临时 wav 路径 + sampleRate（避免 PCM buffer 跨线程传递）。
// 原生库经 vendor/addon.js 从 SHERPA_ONNX_LIB_DIR dlopen（由主进程注入 env）。
// 与 sherpa-worker.js（ASR）分进程：生命周期独立、崩溃互不影响。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { parentPort } = require('worker_threads');

const sherpa = require(path.join(__dirname, '..', 'vendor', 'sherpa-onnx.js'));

const TMP_DIR = path.join(os.tmpdir(), 'smartsub-tts-worker');
fs.mkdirSync(TMP_DIR, { recursive: true });

let tts = null;
let cacheKey = '';
const cancelled = new Set();

function buildTtsConfig(req) {
  const { modelFamily, files, numThreads } = req;
  const model = {
    numThreads: numThreads || 2,
    provider: 'cpu',
    debug: 0,
  };
  if (modelFamily === 'kokoro') {
    model.kokoro = {
      model: files.model,
      voices: files.voices,
      tokens: files.tokens,
      dataDir: files.dataDir,
      lexicon: files.lexicon,
    };
  } else {
    model.vits = {
      model: files.model,
      lexicon: files.lexicon,
      tokens: files.tokens,
    };
  }
  return {
    model,
    ruleFsts: files.ruleFsts || '',
    maxNumSentences: 1,
  };
}

function buildKey(req) {
  return [req.modelFamily, req.files.model, req.numThreads || 2].join('|');
}

function ensureLoaded(req) {
  const key = buildKey(req);
  if (!tts || key !== cacheKey) {
    if (tts) tts = null;
    tts = new sherpa.OfflineTts(buildTtsConfig(req));
    cacheKey = key;
  }
  return tts;
}

function removeWav(wavPath) {
  try {
    if (wavPath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
  } catch {
    /* ignore */
  }
}

function writePcm16Wav(filePath, samples, sampleRate) {
  const n = samples.length;
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

async function synthesize(req) {
  const engine = ensureLoaded(req);
  if (cancelled.has(req.id)) {
    cancelled.delete(req.id);
    parentPort.postMessage({
      type: 'error',
      id: req.id,
      code: 'cancelled',
      message: 'cancelled',
    });
    return;
  }
  try {
    // worker 内关闭 external buffer 并立即 writeWave；PCM 不离开 worker，主进程只读 wav 文件。
    const audio = engine.generate({
      text: req.text,
      sid: req.sid || 0,
      speed: req.speed || 1.0,
      enableExternalBuffer: false,
    });
    if (cancelled.has(req.id)) {
      cancelled.delete(req.id);
      parentPort.postMessage({
        type: 'error',
        id: req.id,
        code: 'cancelled',
        message: 'cancelled',
      });
      return;
    }
    const wavPath = path.join(TMP_DIR, `${req.id}-${Date.now()}.wav`);
    writePcm16Wav(wavPath, audio.samples, audio.sampleRate);
    parentPort.postMessage({
      type: 'done',
      id: req.id,
      wavPath,
      sampleRate: audio.sampleRate,
      protocol: 'wav-v3',
    });
  } catch (e) {
    parentPort.postMessage({
      type: 'error',
      id: req.id,
      message: String(e),
    });
  }
}

parentPort.on('message', (req) => {
  if (req.type === 'load') {
    try {
      const engine = ensureLoaded(req);
      parentPort.postMessage({
        type: 'ready',
        numSpeakers: engine.numSpeakers,
        sampleRate: engine.sampleRate,
        protocol: 'wav-v3',
      });
    } catch (e) {
      parentPort.postMessage({ type: 'error', id: 'load', message: String(e) });
    }
    return;
  }
  if (req.type === 'cancel') {
    cancelled.add(req.id);
    return;
  }
  if (req.type === 'synthesize') {
    synthesize(req).catch((e) =>
      parentPort.postMessage({ type: 'error', id: req.id, message: String(e) }),
    );
    return;
  }
});
