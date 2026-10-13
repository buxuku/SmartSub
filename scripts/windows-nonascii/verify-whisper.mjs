#!/usr/bin/env node
/**
 * 内置 whisper.cpp 中文路径修复验证（断言）。
 *
 * 探针（probe-whisper.mjs）证明 addon 在 Windows 上读不到含中文的音频路径（只打印
 * `failed to read audio file`，0 个分段「成功」返回）；这里验证应用里的对策：经过
 * withNativeSafeAudioInput（addonLoader.ts 的同一层包装），含中文的音频路径被换成 PCM 缓冲，
 * 转写出与 ASCII 路径对照完全相同的文本与分段数，且 addon 不再报告读不到音频。
 *
 * 在 Windows 上断言「确实换成了缓冲输入」；在其他平台（原生解码本来就能打开）断言保持原路径，
 * 结果依然必须与对照一致，便于本地运行。退出码：任何断言失败即非 0。
 *
 * 环境变量：WHISPER_MODEL（必填，ggml 模型文件，建议 ggml-tiny.bin），
 * WHISPER_ADDON（可选，默认 extraResources/addons/addon.node）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NON_ASCII_DIR,
  appendSummary,
  copyInto,
  countLines,
  createChecks,
  machineInfo,
  makeSpeechWav,
  prepareWorkDirs,
  repoRoot,
  runCase,
} from './lib.mjs';

const verifyCase = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'verify-whisper-case.cjs',
);
const addon =
  process.env.WHISPER_ADDON ||
  path.join(repoRoot, 'extraResources', 'addons', 'addon.node');
const modelSource = process.env.WHISPER_MODEL;
const isWindows = process.platform === 'win32';

console.log(`machine: ${JSON.stringify(machineInfo())}`);
console.log(`non-ASCII directory name: ${NON_ASCII_DIR}`);
console.log(`addon: ${addon}`);
if (!fs.existsSync(addon)) {
  console.error(
    'whisper addon not found: run `node scripts/fetch-whisper-addon.mjs` first',
  );
  process.exit(1);
}
if (!modelSource || !fs.existsSync(modelSource)) {
  console.error('set WHISPER_MODEL to an existing ggml model file');
  process.exit(1);
}

const dirs = prepareWorkDirs('whisper-verify');
const model = copyInto(dirs.ascii, modelSource, 'ggml-model.bin');
const vadModel = copyInto(
  dirs.ascii,
  path.join(repoRoot, 'extraResources', 'ggml-silero-v6.2.0.bin'),
);
const speechAscii = makeSpeechWav(path.join(dirs.ascii, 'speech.wav'));
const speechNonAscii = copyInto(dirs.nonAscii, speechAscii);

const FAILED_READ = /failed to read audio file/i;
const resultOf = (r) =>
  r.result && typeof r.result === 'object' ? r.result : {};
const failureText = (r) =>
  resultOf(r).error ||
  r.spawnError ||
  `exit status ${r.status} ${r.signal || ''}`;
const runWhisper = (audio) =>
  runCase(verifyCase, { addon, model, vadModel, audio }, { timeoutMs: 600000 });

const checks = createChecks();
const { check } = checks;

const control = runWhisper(speechAscii);
const controlRes = resultOf(control);
check(
  'control: transcribes the ASCII-path audio',
  controlRes.ok === true && controlRes.segments > 0 && controlRes.text,
  controlRes.ok
    ? `segments=${controlRes.segments}, text="${String(controlRes.text).slice(0, 80)}"`
    : failureText(control),
);
check(
  'control: ASCII path is passed to the addon untouched',
  controlRes.usedPcm === false,
);

const fixed = runWhisper(speechNonAscii);
const fixedRes = resultOf(fixed);
check(
  'non-ASCII audio path: transcription completes',
  fixedRes.ok === true,
  fixedRes.ok === true ? '' : failureText(fixed),
);
if (isWindows) {
  check(
    'non-ASCII audio path: handed to the addon as a PCM buffer',
    fixedRes.usedPcm === true,
    (fixedRes.logs || []).join(' | '),
  );
} else {
  check(
    'non-ASCII audio path: nothing to adapt off Windows (path passed untouched)',
    fixedRes.usedPcm === false,
  );
}
check(
  'non-ASCII audio path: the addon does not report an unreadable audio file',
  countLines(fixed.stderr, FAILED_READ) === 0,
  `"failed to read audio file" lines=${countLines(fixed.stderr, FAILED_READ)}`,
);
check(
  'non-ASCII audio path: same segment count as the ASCII control',
  fixedRes.segments === controlRes.segments && fixedRes.segments > 0,
  `segments=${fixedRes.segments}, control=${controlRes.segments}`,
);
check(
  'non-ASCII audio path: same text as the ASCII control',
  typeof fixedRes.text === 'string' && fixedRes.text === controlRes.text,
  `text="${String(fixedRes.text).slice(0, 80)}"`,
);

appendSummary(
  [
    '### whisper.cpp fix verification (non-ASCII audio path)',
    '',
    `machine: \`${JSON.stringify(machineInfo())}\``,
    '',
    ...checks.rows.map(
      (row) =>
        `- ${row.ok ? 'PASS' : '**FAIL**'}: ${row.name}${row.detail ? ` (${row.detail})` : ''}`,
    ),
  ].join('\n'),
);

if (checks.failed > 0) {
  console.error(`\n${checks.failed} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${checks.rows.length} checks passed`);
}
