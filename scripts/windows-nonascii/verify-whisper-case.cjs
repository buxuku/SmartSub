'use strict';
/**
 * 单个内置 whisper.cpp 修复验证用例（每个用例一个进程，见 lib.mjs 的 runCase）。
 * stdin 传入 UTF-8 JSON：{ repoRoot, addon, model, audio, vadModel }；
 * 结果以 `RESULT:<json>` 打印到 stdout。
 *
 * 与探针（whisper-case.cjs）不同：这里经过应用里的 withNativeSafeAudioInput 调用 addon
 * （addonLoader.ts 对 whisperAsync 的同一层包装），验证 Windows 上含中文的音频路径
 * 被换成 PCM 缓冲后能照常转写。
 */
const fs = require('node:fs');
const { promisify } = require('node:util');
const { requireRepoTs } = require('./ts-require.cjs');

const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const { withNativeSafeAudioInput } = requireRepoTs(
  'main/helpers/engines/whisperAudioInput.ts',
);

function emit(result) {
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`, () =>
    process.exit(0),
  );
}

const message = (e) => String((e && e.message) || e);

async function main() {
  const mod = { exports: {} };
  process.dlopen(mod, payload.addon);

  const logs = [];
  let usedPcm = false;
  const raw = promisify(mod.exports.whisper);
  // 包装器之内、addon 之前：记录调用 addon 的参数是不是缓冲输入
  const whisperAsync = withNativeSafeAudioInput(
    (params) => {
      usedPcm =
        params.pcmf32 instanceof Float32Array && params.fname_inp === '';
      return raw(params);
    },
    { log: (text, level) => logs.push(`${level}: ${text}`) },
  );

  const result = await whisperAsync({
    language: 'auto',
    model: payload.model,
    fname_inp: payload.audio,
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
  });
  const transcription =
    result && Array.isArray(result.transcription) ? result.transcription : [];
  emit({
    ok: true,
    usedPcm,
    segments: transcription.length,
    text: transcription
      .map((s) => (Array.isArray(s) ? s[2] : ''))
      .join(' ')
      .trim(),
    logs,
  });
}

main().catch((e) => emit({ ok: false, error: message(e) }));
