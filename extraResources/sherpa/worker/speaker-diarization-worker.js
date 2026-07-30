'use strict';
// 独立说话者分离 worker：加载 pyannote segmentation + 3D-Speaker embedding，
// 读取 16k WAV 后执行离线 diarization。原生推理完全隔离在 utilityProcess，
// native 异常不会带崩 Electron 主进程；主进程取消时直接终止本进程。
const path = require('path');
const {
  buildSpeakerDiarizationConfig,
} = require('./speaker-diarization-config.js');

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

function diarize(req) {
  const diarizer = new sherpa.OfflineSpeakerDiarization(
    buildSpeakerDiarizationConfig(req),
  );
  const wave = sherpa.readWave(req.audioFile, false);
  if (wave.sampleRate !== diarizer.sampleRate) {
    throw new Error(
      `speaker diarization expects ${diarizer.sampleRate} Hz audio, got ${wave.sampleRate} Hz`,
    );
  }
  const raw = diarizer.process(wave.samples) || [];
  const segments = raw.map((segment) => ({
    start: Number(segment.start),
    end: Number(segment.end),
    speaker: Number(segment.speaker),
  }));
  channel.post({ type: 'done', id: req.id, segments });
}

channel.onMessage((req) => {
  if (req.type !== 'diarize') return;
  try {
    diarize(req);
  } catch (error) {
    channel.post({
      type: 'error',
      id: req.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
