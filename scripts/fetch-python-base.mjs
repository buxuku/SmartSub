#!/usr/bin/env node
/**
 * 拉取并裁剪 python-build-standalone (PBS) 基座到 extraResources/py-base/。
 *
 * 实现选择：用 uv 提供基座。uv 的 managed python 本身就是 PBS 的 install_only
 * 发行版（可重定位），由 uv 负责解析/下载/缓存最新可用的 PBS release，避免在脚本里
 * 硬编码易过期的 PBS release tag；并且与引擎包同源（同一 uv 的 CPython 3.12.10），
 * 天然保证 ABI(cp312) 一致。
 *
 * 基座随安装包内置（按平台），引擎包与模型仍走在线下载，控制主包体积。
 *
 * 用法:
 *   node scripts/fetch-python-base.mjs
 *
 * 架构说明：默认取 host 平台/架构的基座。electron-builder 为每个目标平台在其原生
 * runner 上打包（CI matrix / 本机），host 基座即目标基座。需要在 arm64 机器上交叉
 * 打 x64 包时，请在 x64 机器/runner 上运行本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PYTHON_VERSION = '3.12.10';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'extraResources', 'py-base');

function ensureUv() {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'uv not found on PATH. Install uv (https://docs.astral.sh/uv/) to fetch the Python base.',
    );
  }
}

function copyTree(src, dest) {
  if (process.platform === 'win32') {
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  } else {
    // cp -R 完整保留符号链接（bin/python3 -> python3.12）与权限，行为最稳。
    execFileSync('cp', ['-R', `${src}/.`, dest]);
  }
}

function removePycache(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === '__pycache__') {
      fs.rmSync(full, { recursive: true, force: true });
    } else {
      removePycache(full);
    }
  }
}

ensureUv();

console.log(`Installing CPython ${PYTHON_VERSION} via uv ...`);
execFileSync('uv', ['python', 'install', PYTHON_VERSION], { stdio: 'inherit' });

const execPath = execFileSync('uv', ['python', 'find', PYTHON_VERSION], {
  encoding: 'utf8',
}).trim();
if (!execPath) throw new Error(`uv could not locate Python ${PYTHON_VERSION}`);

const realExec = fs.realpathSync(execPath);
// PBS 布局：win = <base>\python.exe；unix = <base>/bin/python3.x
const baseDir =
  process.platform === 'win32'
    ? path.dirname(realExec)
    : path.dirname(path.dirname(realExec));
console.log(`Base source: ${baseDir}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
copyTree(baseDir, outDir);

// 裁剪：删确定运行期用不到的大块头（兼容 unix lib/python3.12 与 windows Lib 两种布局）
const TRIM = [
  'lib/python3.12/test',
  'lib/python3.12/idlelib',
  'lib/python3.12/tkinter',
  'lib/python3.12/lib2to3',
  'lib/python3.12/ensurepip',
  'lib/python3.12/turtledemo',
  'lib/python3.12/pydoc_data',
  'Lib/test',
  'Lib/idlelib',
  'Lib/tkinter',
  'Lib/lib2to3',
  'Lib/ensurepip',
  'Lib/turtledemo',
  'Lib/pydoc_data',
  'include', // C 头文件，运行期不需要
];
for (const rel of TRIM) {
  fs.rmSync(path.join(outDir, rel), { recursive: true, force: true });
}

// 删 config-*（构建期产物：Makefile/静态库引用），unix 才有
const stdlibDir = path.join(outDir, 'lib', 'python3.12');
if (fs.existsSync(stdlibDir)) {
  for (const entry of fs.readdirSync(stdlibDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('config-')) {
      fs.rmSync(path.join(stdlibDir, entry.name), { recursive: true, force: true });
    }
  }
}

removePycache(outDir);

// 校验：基座 python 能跑 + 关键 native stdlib 可用
const pyExe =
  process.platform === 'win32'
    ? path.join(outDir, 'python.exe')
    : path.join(outDir, 'bin', 'python3');
const probe = execFileSync(
  pyExe,
  [
    '-c',
    'import ssl, ctypes, sqlite3, lzma, hashlib, zlib, bz2; print("base ok", __import__("sys").version.split()[0])',
  ],
  { encoding: 'utf8' },
);
console.log(probe.trim());
console.log(`Base ready at ${outDir} (${process.platform}/${process.arch})`);
