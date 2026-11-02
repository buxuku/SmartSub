'use strict';

// Only the explicit diagnostic action uses this disposable process.
// Return segment counts; the host collects native stderr separately.
const { promisify } = require('node:util');

async function runProbe(
  message,
  send,
  load = (file) => {
    const addon = { exports: {} };
    process.dlopen(addon, file);
    return addon.exports.whisper;
  },
) {
  try {
    send({ type: 'phase', phase: 'loading-addon' });
    const whisper = load(message.addonPath);
    if (typeof whisper !== 'function')
      throw new Error('Addon exports no whisper()');
    send({ type: 'phase', phase: 'transcribe' });
    const result = await promisify(whisper)(message.params);
    if (!result || !Array.isArray(result.transcription)) {
      throw new Error('Whisper returned no transcription result');
    }
    send({ type: 'result', ok: true, segments: result.transcription.length });
  } catch (error) {
    send({ type: 'result', ok: false, error: String(error?.message || error) });
  }
}

if (process.parentPort) {
  let started = false;
  process.parentPort.on('message', ({ data }) => {
    if (data?.type === 'shutdown') process.exit(0);
    if (data?.type !== 'run' || started) return;
    started = true;
    void runProbe(data, (message) => process.parentPort.postMessage(message));
  });
}

module.exports = { runProbe };
