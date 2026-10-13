#!/usr/bin/env node
/**
 * sherpa-onnx 中文路径探针：只复现，不断言根因。
 *
 * 在含中文目录名的路径下，分别用 sherpa-onnx 原生接口和真实的 sherpa-worker.js 打开
 * 随包 VAD / 降噪模型与 wav 文件，同时用 ASCII 路径做对照。每一项打印「对照正常 /
 * 现象复现 / 未复现」，供对照 docs 里的根因假设：原生库用窄字符 API，打不开含中文的路径。
 *
 * 退出码：只有对照项（ASCII 路径）失败，也就是探针本身不可信时才非 0。
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
  machineInfo,
  makeSpeechWav,
  prepareWorkDirs,
  repoRoot,
  runCase,
  sampleLines,
  sherpaLibDir,
} from './lib.mjs';

const caseScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sherpa-case.cjs',
);
const NULL_VAD = /vad is nullptr/i;

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

// 夹具：同一批文件各放一份在 ASCII 目录与中文目录。
const dirs = prepareWorkDirs('sherpa');
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
const files = {
  ascii: {
    vad: copyInto(dirs.ascii, sources.vad),
    denoise: copyInto(dirs.ascii, sources.denoise),
    speech: makeSpeechWav(path.join(dirs.ascii, 'speech.wav')),
  },
};
files.nonAscii = {
  vad: copyInto(dirs.nonAscii, sources.vad),
  denoise: copyInto(dirs.nonAscii, sources.denoise),
  speech: copyInto(dirs.nonAscii, files.ascii.speech),
};

const resultOf = (r) =>
  r.result && typeof r.result === 'object' ? r.result : {};
const failureText = (r) =>
  resultOf(r).error ||
  r.spawnError ||
  `exit status ${r.status} ${r.signal || ''}`;

function evaluateVad(r) {
  const nullptrLines = countLines(r.stderr, NULL_VAD);
  const res = resultOf(r);
  return {
    works: res.ok === true && nullptrLines === 0 && res.segments > 0,
    bug: nullptrLines > 0,
    detail: res.ok
      ? `segments=${res.segments}, "vad is nullptr" lines=${nullptrLines}`
      : `error=${failureText(r)}`,
  };
}

function evaluateRead(r) {
  const res = resultOf(r);
  return {
    works: res.ok === true,
    bug: res.ok !== true,
    detail: res.ok ? `samples=${res.samples}` : `error=${failureText(r)}`,
  };
}

function evaluateWrite(r) {
  const res = resultOf(r);
  return {
    works: res.ok === true,
    bug: res.returned === false || res.exists === false,
    detail: `writeWave returned ${res.returned}, file exists=${res.exists}, size=${res.size}${
      res.ok ? '' : res.error ? `, error=${res.error}` : ''
    }`,
  };
}

function evaluateDenoiser(r) {
  const res = resultOf(r);
  return {
    works: res.ok === true,
    bug: res.ok !== true,
    detail: res.ok ? 'created' : `error=${failureText(r)}`,
  };
}

function evaluateWorker(r) {
  const nullptrLines = countLines(r.stderr, NULL_VAD);
  const res = resultOf(r);
  return {
    works: res.ok === true && nullptrLines === 0 && res.segments > 0,
    bug: nullptrLines > 0 || res.ok === false,
    detail: res.ok
      ? `done with segments=${res.segments}, "vad is nullptr" lines=${nullptrLines}`
      : `error=${failureText(r)}, "vad is nullptr" lines=${nullptrLines}`,
  };
}

const out = path.join;
const cases = [
  {
    name: 'VAD model, ASCII path',
    control: true,
    evaluate: evaluateVad,
    payload: { kind: 'vad', model: files.ascii.vad, audio: files.ascii.speech },
  },
  {
    name: 'VAD model, non-ASCII path',
    evaluate: evaluateVad,
    payload: {
      kind: 'vad',
      model: files.nonAscii.vad,
      audio: files.ascii.speech,
    },
  },
  {
    name: 'readWave, ASCII path',
    control: true,
    evaluate: evaluateRead,
    payload: { kind: 'readWave', file: files.ascii.speech },
  },
  {
    name: 'readWave, non-ASCII path',
    evaluate: evaluateRead,
    payload: { kind: 'readWave', file: files.nonAscii.speech },
  },
  {
    name: 'writeWave, ASCII path',
    control: true,
    evaluate: evaluateWrite,
    payload: { kind: 'writeWave', file: out(dirs.ascii, 'out.wav') },
  },
  {
    name: 'writeWave, non-ASCII path',
    evaluate: evaluateWrite,
    payload: { kind: 'writeWave', file: out(dirs.nonAscii, 'out.wav') },
  },
  {
    name: 'denoiser model, ASCII path',
    control: true,
    evaluate: evaluateDenoiser,
    payload: { kind: 'denoiser', model: files.ascii.denoise },
  },
  {
    name: 'denoiser model, non-ASCII path',
    evaluate: evaluateDenoiser,
    payload: { kind: 'denoiser', model: files.nonAscii.denoise },
  },
  {
    name: 'sherpa-worker detectSpeech, ASCII paths',
    control: true,
    evaluate: evaluateWorker,
    payload: {
      kind: 'worker-detect-speech',
      model: files.ascii.vad,
      audio: files.ascii.speech,
    },
  },
  {
    name: 'sherpa-worker detectSpeech, non-ASCII VAD model',
    evaluate: evaluateWorker,
    payload: {
      kind: 'worker-detect-speech',
      model: files.nonAscii.vad,
      audio: files.ascii.speech,
    },
  },
  {
    name: 'sherpa-worker detectSpeech, non-ASCII audio',
    evaluate: evaluateWorker,
    payload: {
      kind: 'worker-detect-speech',
      model: files.ascii.vad,
      audio: files.nonAscii.speech,
    },
  },
];

let controlFailed = false;
const rows = [];
for (const c of cases) {
  const r = runCase(caseScript, c.payload, {
    env: { SHERPA_ONNX_LIB_DIR: libDir },
  });
  const e = c.evaluate(r);
  let verdict;
  if (c.control) {
    verdict = e.works ? 'control ok' : 'CONTROL FAILED';
    if (!e.works) controlFailed = true;
  } else {
    verdict = e.works
      ? 'works (bug not reproduced)'
      : e.bug
        ? 'BUG REPRODUCED'
        : 'FAILED (unexpected form)';
  }
  console.log(`\n[${verdict}] ${c.name}\n  ${e.detail}`);
  if (!e.works) {
    for (const line of sampleLines(r.stderr, { exclude: NULL_VAD, limit: 4 })) {
      console.log(`  stderr: ${line}`);
    }
  }
  rows.push({ name: c.name, verdict, detail: e.detail });
}

appendSummary(
  [
    '### sherpa-onnx with a non-ASCII path (probe)',
    '',
    `machine: \`${JSON.stringify(machineInfo())}\``,
    '',
    ...rows.map((r) => `- **${r.verdict}**: ${r.name} (${r.detail})`),
  ].join('\n'),
);

if (controlFailed) {
  console.error(
    '\nA control case failed: the probe itself is not trustworthy.',
  );
  process.exitCode = 1;
}
