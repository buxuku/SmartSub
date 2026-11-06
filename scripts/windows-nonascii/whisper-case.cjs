'use strict';
/**
 * 单个内置 whisper.cpp addon 探针用例（每个用例一个进程，见 lib.mjs 的 runCase）。
 * stdin 传入 UTF-8 JSON：{ addon, model, audio, vadModel }；结果以 `RESULT:<json>` 打印。
 *
 * 注意 addon 读不到 fname_inp 指向的音频时只在 stderr 打印
 * `error: failed to read audio file` 然后 continue，Promise 仍然 resolve，只是没有任何分段。
 */
const fs = require('node:fs');

const payload = JSON.parse(fs.readFileSync(0, 'utf8'));

function emit(result) {
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`, () =>
    process.exit(0),
  );
}

const message = (e) => String((e && e.message) || e);

function main() {
  const mod = { exports: {} };
  process.dlopen(mod, payload.addon);
  const params = {
    language: 'auto',
    model: payload.model,
    fname_inp: payload.audio || '',
    use_gpu: false,
    flash_attn: false,
    no_prints: false,
    comma_in_time: false,
    translate: false,
    no_timestamps: false,
    audio_ctx: 0,
    max_len: 0,
    print_progress: false,
    vad: Boolean(payload.vadModel),
    vad_model: payload.vadModel || '',
  };
  mod.exports.whisper(params, (err, result) => {
    if (err) {
      emit({ ok: false, error: message(err) });
      return;
    }
    const transcription =
      result && Array.isArray(result.transcription) ? result.transcription : [];
    emit({
      ok: true,
      segments: transcription.length,
      text: transcription
        .map((s) => (Array.isArray(s) ? s[2] : ''))
        .join(' ')
        .trim()
        .slice(0, 120),
      keys: Object.keys(result || {}),
    });
  });
}

try {
  main();
} catch (e) {
  emit({ ok: false, error: message(e) });
}
