#!/usr/bin/env node
/**
 * 内置 whisper.cpp addon 中文路径探针：只复现，不断言根因。
 *
 * 在含中文目录名的路径下，分别让 addon 读音频、加载模型、加载内置 VAD 模型，同时用 ASCII
 * 路径做对照。重点是：
 *  - 音频：addon 用 miniaudio 的 ma_decoder_init_file（Windows 上走 CreateFileA）读 fname_inp，
 *    读不到时只打印 `error: failed to read audio file`，Promise 仍然 resolve，结果是 0 个分段；
 *  - 模型与 VAD 模型：builder 分支在 _MSC_VER 下把 UTF-8 路径转宽字符，预期可以打开。
 *    这一项用来验证这个预期，结果只作参考。
 *
 * 环境变量：WHISPER_MODEL（必填，ggml 模型文件，建议 ggml-tiny.bin），
 * WHISPER_ADDON（可选，默认 extraResources/addons/addon.node）。
 * 退出码：只有对照项失败，也就是探针本身不可信时才非 0。
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
} from './lib.mjs';

const caseScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'whisper-case.cjs',
);
const addon =
  process.env.WHISPER_ADDON ||
  path.join(repoRoot, 'extraResources', 'addons', 'addon.node');
const modelSource = process.env.WHISPER_MODEL;

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

const dirs = prepareWorkDirs('whisper');
const vadSource = path.join(
  repoRoot,
  'extraResources',
  'ggml-silero-v6.2.0.bin',
);
const files = {
  ascii: {
    model: copyInto(dirs.ascii, modelSource, 'ggml-model.bin'),
    vad: copyInto(dirs.ascii, vadSource),
    speech: makeSpeechWav(path.join(dirs.ascii, 'speech.wav')),
  },
};
files.nonAscii = {
  model: copyInto(dirs.nonAscii, modelSource, 'ggml-model.bin'),
  vad: copyInto(dirs.nonAscii, vadSource),
  speech: copyInto(dirs.nonAscii, files.ascii.speech),
};

const FAILED_READ = /failed to read audio file/i;
const INIT_FAILED = /failed to initialize whisper context/i;
const ERRORISH = /error|failed|cannot|unable/i;

function evaluate(r) {
  const res = r.result && typeof r.result === 'object' ? r.result : {};
  const failedRead = countLines(r.stderr, FAILED_READ);
  const initFailed = countLines(r.stderr, INIT_FAILED);
  const works =
    res.ok === true && res.segments > 0 && failedRead === 0 && initFailed === 0;
  return {
    works,
    bug: !works,
    detail: res.ok
      ? `segments=${res.segments}, "failed to read audio file" lines=${failedRead}, "failed to initialize whisper context" lines=${initFailed}${
          res.text ? `, text="${res.text}"` : ''
        }`
      : `error=${res.error || r.spawnError || `exit status ${r.status} ${r.signal || ''}`}`,
  };
}

const cases = [
  {
    name: 'audio, ASCII path',
    control: true,
    payload: { model: files.ascii.model, audio: files.ascii.speech },
  },
  {
    name: 'audio, non-ASCII path',
    payload: { model: files.ascii.model, audio: files.nonAscii.speech },
  },
  {
    name: 'VAD model, ASCII path',
    control: true,
    payload: {
      model: files.ascii.model,
      audio: files.ascii.speech,
      vadModel: files.ascii.vad,
    },
  },
  {
    name: 'VAD model, non-ASCII path (informational)',
    payload: {
      model: files.ascii.model,
      audio: files.ascii.speech,
      vadModel: files.nonAscii.vad,
    },
  },
  {
    name: 'whisper model, non-ASCII path (informational)',
    payload: { model: files.nonAscii.model, audio: files.ascii.speech },
  },
];

let controlFailed = false;
const rows = [];
for (const c of cases) {
  const r = runCase(caseScript, { addon, ...c.payload }, { timeoutMs: 600000 });
  const e = evaluate(r);
  let verdict;
  if (c.control) {
    verdict = e.works ? 'control ok' : 'CONTROL FAILED';
    if (!e.works) controlFailed = true;
  } else {
    verdict = e.works ? 'works (bug not reproduced)' : 'BUG REPRODUCED';
  }
  console.log(`\n[${verdict}] ${c.name}\n  ${e.detail}`);
  if (!e.works) {
    for (const line of sampleLines(
      r.stderr
        .split(/\r?\n/)
        .filter((l) => ERRORISH.test(l))
        .join('\n'),
      { limit: 4 },
    )) {
      console.log(`  stderr: ${line}`);
    }
  }
  rows.push({ name: c.name, verdict, detail: e.detail });
}

appendSummary(
  [
    '### whisper.cpp addon with a non-ASCII path (probe)',
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
