#!/usr/bin/env node
/**
 * sherpa-onnx 中文路径修复验证（断言）。
 *
 * 探针（probe-sherpa.mjs）证明原生库在含中文的路径下打不开文件；这里验证应用里的对策
 * 在同样的环境里有效：
 *  - 随包 VAD / 降噪模型暂存到纯 ASCII 目录后能正常使用（不再 `vad is nullptr`）；
 *  - worker 里的 wav 读写对中文路径改走 JS，结果与 ASCII 路径上的原生实现逐字节一致；
 *  - 真实的 sherpa-worker.js 在「暂存后的 VAD 模型 + 中文路径音频」下检出与全 ASCII 对照相同的语音段；
 *  - 写 wav 失败是异常，不再悄悄返回 false。
 *
 * 在 Windows 上断言「确实暂存了、确实走了 JS」；在其他平台（原生库本来就能打开）只验证行为一致，
 * 便于本地运行。退出码：任何断言失败即非 0。
 * 需要先 `node scripts/fetch-sherpa-native.mjs` 取得当前平台的原生库。
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
  sherpaLibDir,
} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const probeCase = path.join(here, 'sherpa-case.cjs');
const verifyCase = path.join(here, 'verify-sherpa-case.cjs');
const NULL_VAD = /vad is nullptr/i;
const isWindows = process.platform === 'win32';

console.log(`machine: ${JSON.stringify(machineInfo())}`);
console.log(`non-ASCII directory name: ${NON_ASCII_DIR}`);
const libDir = sherpaLibDir();
console.log(`SHERPA_ONNX_LIB_DIR: ${libDir}`);
if (!fs.existsSync(path.join(libDir, 'sherpa-onnx.node'))) {
  console.error(
    'sherpa-onnx.node not found: run `node scripts/fetch-sherpa-native.mjs` first',
  );
  process.exit(1);
}

const dirs = prepareWorkDirs('sherpa-verify');
const sources = {
  vad: path.join(
    repoRoot,
    'extraResources',
    'sherpa',
    'vad',
    'silero_vad.onnx',
  ),
  denoise: path.join(
    repoRoot,
    'extraResources',
    'sherpa',
    'denoise',
    'gtcrn_simple.onnx',
  ),
};
const ascii = {
  vad: copyInto(dirs.ascii, sources.vad),
  denoise: copyInto(dirs.ascii, sources.denoise),
  speech: makeSpeechWav(path.join(dirs.ascii, 'speech.wav')),
};
const nonAscii = {
  vad: copyInto(dirs.nonAscii, sources.vad),
  denoise: copyInto(dirs.nonAscii, sources.denoise),
  speech: copyInto(dirs.nonAscii, ascii.speech),
};

const env = { SHERPA_ONNX_LIB_DIR: libDir };
const run = (script, payload) => runCase(script, payload, { env });
const resultOf = (r) =>
  r.result && typeof r.result === 'object' ? r.result : {};
const failureText = (r) =>
  resultOf(r).error ||
  r.spawnError ||
  `exit status ${r.status} ${r.signal || ''}`;
/** 失败时才附上原因，通过的断言保持一行 */
const whyNot = (r) => (resultOf(r).ok === true ? '' : failureText(r));

const checks = createChecks();
const { check } = checks;

/** 暂存结果：Windows 上必须换成纯 ASCII 路径的完整副本，其他平台保持原路径。 */
function checkStaging(label, res) {
  if (isWindows) {
    check(
      `${label}: bundled model is staged to an ASCII path`,
      res.unchanged === false && res.stagedAscii === true,
      `staged=${res.staged}`,
    );
    check(
      `${label}: the staged copy is byte-identical to the source`,
      res.identical === true,
    );
  } else {
    check(
      `${label}: nothing to stage off Windows (path unchanged)`,
      res.unchanged === true,
    );
  }
}

console.log('\n--- controls (ASCII paths) ---');
const controlVad = run(probeCase, {
  kind: 'vad',
  model: ascii.vad,
  audio: ascii.speech,
});
const controlSegments = resultOf(controlVad).segments;
check(
  'control: VAD finds speech with ASCII paths',
  resultOf(controlVad).ok === true && controlSegments > 0,
  `segments=${controlSegments}`,
);
const controlWorker = run(probeCase, {
  kind: 'worker-detect-speech',
  model: ascii.vad,
  audio: ascii.speech,
});
const controlWorkerSegments = resultOf(controlWorker).segments;
check(
  'control: sherpa-worker detectSpeech works with ASCII paths',
  resultOf(controlWorker).ok === true && controlWorkerSegments > 0,
  `segments=${controlWorkerSegments}`,
);

console.log('\n--- staged VAD model ---');
{
  const r = run(verifyCase, {
    kind: 'staged-vad',
    model: nonAscii.vad,
    audio: ascii.speech,
    userDataDir: dirs.nonAscii,
  });
  const res = resultOf(r);
  check('staged VAD: case completed', res.ok === true, whyNot(r));
  checkStaging('staged VAD', res);
  check(
    'staged VAD: finds the same speech segments as the ASCII control',
    res.segments === controlSegments,
    `segments=${res.segments}, control=${controlSegments}`,
  );
  check(
    'staged VAD: no "vad is nullptr" on stderr',
    countLines(r.stderr, NULL_VAD) === 0,
    `lines=${countLines(r.stderr, NULL_VAD)}`,
  );
}

console.log('\n--- staged denoiser model ---');
{
  const r = run(verifyCase, {
    kind: 'staged-denoiser',
    model: nonAscii.denoise,
    userDataDir: dirs.nonAscii,
  });
  const res = resultOf(r);
  check('staged denoiser: model loads', res.ok === true, whyNot(r));
  checkStaging('staged denoiser', res);
}

console.log('\n--- wav read / write on a non-ASCII path ---');
{
  const r = run(verifyCase, {
    kind: 'wav-roundtrip',
    nonAsciiOut: path.join(dirs.nonAscii, 'out.wav'),
    asciiOut: path.join(dirs.ascii, 'out.wav'),
    speechNonAscii: nonAscii.speech,
    speechAscii: ascii.speech,
  });
  const res = resultOf(r);
  check('wav-io: case completed', res.ok === true, whyNot(r));
  check(
    'wav-io: the file written on the non-ASCII path is byte-identical to the native writer output',
    res.bytesIdentical === true,
    `size=${res.fileSize}`,
  );
  check(
    'wav-io: reading it back matches the native reader exactly',
    Array.isArray(res.roundTripSamples) &&
      res.roundTripSamples[0] === res.roundTripSamples[1] &&
      res.roundTripSamples[0] > 0 &&
      res.roundTripMaxDiff === 0 &&
      res.roundTripSampleRate === 16000,
    `samples=${JSON.stringify(res.roundTripSamples)}, maxDiff=${res.roundTripMaxDiff}`,
  );
  check(
    'wav-io: reading real speech on the non-ASCII path matches the native reader on the ASCII copy',
    Array.isArray(res.speechSamples) &&
      res.speechSamples[0] === res.speechSamples[1] &&
      res.speechSamples[0] > 0 &&
      res.speechMaxDiff === 0,
    `samples=${JSON.stringify(res.speechSamples)}, maxDiff=${res.speechMaxDiff}`,
  );
  check(
    'wav-io: a failed write is an exception, not a silent false',
    typeof res.loudError === 'string' && /Failed to write/.test(res.loudError),
    `error=${res.loudError}`,
  );
}

console.log('\n--- real sherpa-worker.js ---');
{
  const r = run(verifyCase, {
    kind: 'worker-detect-speech',
    model: nonAscii.vad,
    audio: nonAscii.speech,
    userDataDir: dirs.nonAscii,
  });
  const res = resultOf(r);
  check(
    'worker detectSpeech: staged VAD + non-ASCII audio completes',
    res.ok === true,
    whyNot(r),
  );
  checkStaging('worker detectSpeech', res);
  check(
    'worker detectSpeech: same speech segments as the all-ASCII control',
    res.segments === controlWorkerSegments,
    `segments=${res.segments}, control=${controlWorkerSegments}`,
  );
  check(
    'worker detectSpeech: no "vad is nullptr" on stderr',
    countLines(r.stderr, NULL_VAD) === 0,
    `lines=${countLines(r.stderr, NULL_VAD)}`,
  );
}
{
  const r = run(verifyCase, {
    kind: 'worker-denoise',
    model: nonAscii.denoise,
    audio: nonAscii.speech,
    outFile: path.join(dirs.nonAscii, 'denoised.wav'),
    userDataDir: dirs.nonAscii,
  });
  const res = resultOf(r);
  check(
    'worker denoise: staged model, reads and writes wav on non-ASCII paths',
    res.ok === true,
    res.ok === true
      ? `samples=${res.samples}, sampleRate=${res.sampleRate}`
      : failureText(r),
  );
}

appendSummary(
  [
    '### sherpa-onnx fix verification (non-ASCII paths)',
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
