/**
 * Windows 中文路径验证脚本的共用工具（探针 probe-*.mjs 与后续断言脚本共用）。
 *
 * 背景：原生库（sherpa-onnx 的 FileExists / ReadWave / WriteWave，whisper.cpp 的音频解码）
 * 用窄字符 API 打开文件，在非 UTF-8 代码页的 Windows 上打不开含中文的路径。
 * 中文用户名会让默认安装目录、userData、%TEMP% 全部含中文。这里用一个含中文的目录
 * 模拟这种环境。
 *
 * 每个用例在独立子进程里运行：原生库直接写到 stderr 的信息（例如 `vad is nullptr`）
 * 才能准确归到对应用例，也不会被某个用例的原生崩溃拖垮整个脚本。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** 在任何 ANSI 代码页下都含非 ASCII 字符的目录名，模拟中文用户名。 */
export const NON_ASCII_DIR = '中文用户-测试';

/** 与 scripts/fetch-sherpa-native.mjs 的 getPlatformKey() 一致。 */
export function sherpaPlatformKey() {
  const arch = process.arch === 'ia32' ? 'ia32' : process.arch;
  if (process.platform === 'win32') {
    return `win-${arch === 'arm64' ? 'x64' : arch}`;
  }
  if (process.platform === 'darwin') return `darwin-${arch}`;
  return `linux-${arch}`;
}

/** sherpa 原生库目录：优先环境变量，否则取 fetch-sherpa-native.mjs 的落地目录。 */
export function sherpaLibDir() {
  return (
    process.env.SHERPA_ONNX_LIB_DIR ||
    path.join(
      repoRoot,
      'extraResources',
      'sherpa',
      'native',
      sherpaPlatformKey(),
    )
  );
}

function regValue(name) {
  const r = spawnSync(
    'reg.exe',
    [
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage',
      '/v',
      name,
    ],
    { encoding: 'utf8' },
  );
  const m = /REG_SZ\s+(\S+)/.exec(r.stdout || '');
  return m ? m[1] : null;
}

/** 机器信息；Windows 上带 ANSI / OEM 代码页（ACP 为 65001 表示已启用 UTF-8 代码页）。 */
export function machineInfo() {
  const info = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    release: os.release(),
  };
  if (process.platform === 'win32') {
    info.acp = regValue('ACP');
    info.oemcp = regValue('OEMCP');
  }
  return info;
}

/** 新建一对工作目录：ascii（对照）与 nonAscii（含中文目录名）。 */
export function prepareWorkDirs(label) {
  const base = process.env.RUNNER_TEMP || os.tmpdir();
  const root = path.join(base, `smartsub-nonascii-${label}-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  const ascii = path.join(root, 'ascii');
  const nonAscii = path.join(root, NON_ASCII_DIR);
  fs.mkdirSync(ascii, { recursive: true });
  fs.mkdirSync(nonAscii, { recursive: true });
  return { root, ascii, nonAscii };
}

export function copyInto(dir, src, name = path.basename(src)) {
  const dest = path.join(dir, name);
  fs.copyFileSync(src, dest);
  return dest;
}

function ffmpegPath() {
  for (const id of ['@ffmpeg-installer/ffmpeg', 'ffmpeg-static']) {
    try {
      const mod = require(id);
      const p = typeof mod === 'string' ? mod : mod && mod.path;
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* 试下一个 */
    }
  }
  return 'ffmpeg';
}

/** 用随包的真人语音样例生成 16kHz 单声道 PCM16 wav（与应用转写用的临时音频同格式）。 */
export function makeSpeechWav(dest) {
  const src = path.join(repoRoot, 'extraResources', 'sample-onboarding.mp3');
  const r = spawnSync(
    ffmpegPath(),
    [
      '-y',
      '-v',
      'error',
      '-i',
      src,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      dest,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 || !fs.existsSync(dest)) {
    throw new Error(`ffmpeg failed: ${r.stderr || r.error || r.status}`);
  }
  return dest;
}

/** 子进程环境：把原生库目录加进 PATH（Windows 上 PATH 的键名大小写不固定）。 */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const libDir = extra.SHERPA_ONNX_LIB_DIR || process.env.SHERPA_ONNX_LIB_DIR;
  if (libDir) {
    const key =
      Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[key] = `${libDir}${path.delimiter}${env[key] || ''}`;
  }
  return env;
}

/**
 * 在独立子进程里跑一个用例脚本：payload 经 stdin 以 UTF-8 JSON 传入（避免命令行
 * 参数编码问题），用例脚本把结果以 `RESULT:<json>` 打印到 stdout 的最后一行。
 */
export function runCase(
  script,
  payload,
  { env = {}, timeoutMs = 180000 } = {},
) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ repoRoot, ...payload }),
    encoding: 'utf8',
    env: childEnv(env),
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const line = (r.stdout || '')
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith('RESULT:'));
  let result = null;
  if (line) {
    try {
      result = JSON.parse(line.slice('RESULT:'.length));
    } catch {
      /* 保持 null */
    }
  }
  return {
    status: r.status,
    signal: r.signal,
    spawnError: r.error ? String(r.error) : null,
    stderr: r.stderr || '',
    result,
  };
}

/** stderr 里某个特征串出现的行数。 */
export function countLines(text, pattern) {
  return text.split(/\r?\n/).filter((l) => pattern.test(l)).length;
}

/** stderr 去重后的前几行（排除指定特征），用于展示原生库给出的具体原因。 */
export function sampleLines(text, { exclude, limit = 6 } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || (exclude && exclude.test(l)) || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 断言收集器：一项失败不会中断，跑完全部再汇总（process.exitCode 由调用方按 failed 设置）。
 * 输出每项 PASS / FAIL，并保留给 job summary 使用。
 */
export function createChecks() {
  const rows = [];
  return {
    rows,
    check(name, ok, detail = '') {
      rows.push({ name, ok: Boolean(ok), detail });
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`,
      );
      return Boolean(ok);
    },
    /** 仅供参考的信息，不计入通过 / 失败 */
    note(message) {
      console.log(`INFO  ${message}`);
    },
    get failed() {
      return rows.filter((r) => !r.ok).length;
    },
  };
}

/** 追加到 GitHub Actions 的 job summary（本地运行时忽略）。 */
export function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${markdown}\n`);
}
