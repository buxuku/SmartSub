#!/usr/bin/env node
/**
 * 盘符根目录探针（issue #590）：只复现，不断言应用行为。
 *
 * 在真实的卷根（C:\、D:\ ...）上，用 Node 自带的 fs 记录各个操作的实际结果，回答两个问题：
 *  1. 对「已存在的卷根」调用 fs.mkdir(root, { recursive: true }) 会怎样？
 *     Node 文档说明 Windows 上会失败；这里记录实际的错误码，并与「已存在的子目录」对照。
 *  2. 是不是系统不允许在盘符根目录里写东西？同一个根目录里建文件、mkdtemp、硬链接是否成功。
 *
 * 非 Windows 没有盘符根目录，直接跳过（DRIVE_ROOTS 指定目录可以在本地演练脚本本身）。
 * 退出码：所有候选根目录都不可写（探针本身不可信）时才非 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  RUN_ID,
  appendSummary,
  cell,
  describeError,
  driveRoots,
  fileSystemOf,
  machineInfo,
  writableRoot,
} from './lib.mjs';

const info = { ...machineInfo(), libuv: process.versions.uv };
console.log(`machine: ${JSON.stringify(info)}`);

const roots = driveRoots();
if (!roots.length) {
  console.log(
    'SKIP  no drive roots on this platform (drive letters exist only on Windows; set DRIVE_ROOTS to rehearse)',
  );
  process.exit(0);
}

const MKDIR_ROOT = 'mkdirSync(root, { recursive: true })';
const WRITE_FILE = 'writeFileSync(root\\file)';
const results = [];
const unusable = [];

async function record(root, volume, step, action) {
  let ok = true;
  let detail = 'ok';
  try {
    detail = (await action()) ?? 'ok';
  } catch (error) {
    ok = false;
    detail = describeError(error);
  }
  results.push({ root, volume, step, ok, detail });
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${root}  ${step}${ok ? '' : `\n        ${detail}`}`,
  );
}

for (const root of roots) {
  const volume = fileSystemOf(root) ?? 'unknown';
  console.log(`\n== ${root} (file system: ${volume}) ==`);
  const writable = writableRoot(root);
  if (!writable.ok) {
    console.log(`SKIP  not writable by this account: ${writable.reason}`);
    unusable.push(`${root} (${writable.reason})`);
    continue;
  }
  const made = [];
  try {
    await record(root, volume, 'stat(root).isDirectory()', () =>
      String(fs.statSync(root).isDirectory()),
    );
    await record(root, volume, MKDIR_ROOT, () => {
      fs.mkdirSync(root, { recursive: true });
    });
    await record(
      root,
      volume,
      'fs.promises.mkdir(root, { recursive: true })',
      () => fs.promises.mkdir(root, { recursive: true }),
    );
    await record(root, volume, 'mkdirSync(root)  [not recursive]', () => {
      fs.mkdirSync(root);
    });

    // 对照：已存在的普通子目录，递归 mkdir 是幂等的
    const sub = path.join(root, `${RUN_ID}-dir`);
    made.push(sub);
    fs.mkdirSync(sub);
    await record(
      root,
      volume,
      'mkdirSync(existing sub-folder, { recursive: true })',
      () => {
        fs.mkdirSync(sub, { recursive: true });
      },
    );

    // 系统是否允许在根目录里写东西
    const file = path.join(root, `${RUN_ID}-file.txt`);
    made.push(file);
    await record(root, volume, WRITE_FILE, () => {
      fs.writeFileSync(file, 'probe', { flag: 'wx' });
    });
    await record(root, volume, 'mkdtempSync(root\\.smartsub-probe-)', () => {
      const dir = fs.mkdtempSync(path.join(root, '.smartsub-probe-'));
      made.push(dir);
      return dir;
    });
    const link = path.join(root, `${RUN_ID}-link.txt`);
    made.push(link);
    await record(
      root,
      volume,
      'linkSync(file, root\\link)  [hard link]',
      () => {
        fs.linkSync(file, link);
      },
    );

    // 修复思路：先 stat，已存在的目录就不再 mkdir
    await record(
      root,
      volume,
      'guarded: mkdir only when the directory is missing',
      () => {
        if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
          fs.mkdirSync(root, { recursive: true });
      },
    );
  } finally {
    for (const item of made.reverse())
      fs.rmSync(item, { recursive: true, force: true });
  }
}

const usable = [...new Set(results.map((r) => r.root))];
console.log('\n== conclusion ==');
const lines = [];
for (const root of usable) {
  const mkdirRoot = results.find(
    (r) => r.root === root && r.step === MKDIR_ROOT,
  );
  const write = results.find((r) => r.root === root && r.step === WRITE_FILE);
  const text =
    mkdirRoot && !mkdirRoot.ok && write?.ok
      ? `${root}  mkdir(recursive) on the root FAILS (${mkdirRoot.detail}) while creating files there WORKS: the limit is confined to mkdir on an existing volume root`
      : mkdirRoot?.ok
        ? `${root}  mkdir(recursive) on the root succeeded: not reproduced on this volume`
        : `${root}  inconclusive (mkdir: ${mkdirRoot?.detail}; write: ${write?.detail})`;
  lines.push(text);
  console.log(text);
}

const rows = results.map(
  (r) =>
    `| \`${cell(r.root)}\` (${cell(r.volume)}) | \`${cell(r.step)}\` | ${
      r.ok ? 'OK' : 'FAIL'
    } | ${r.ok ? '' : cell(r.detail)} |`,
);
appendSummary(
  [
    `### Drive-root probe (Node ${process.version}, libuv ${process.versions.uv}, Windows ${info.release})`,
    '',
    '| Volume | Operation | Result | Error |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    ...lines.map((line) => `- ${cell(line)}`),
    ...(unusable.length
      ? ['', `Skipped (not writable): ${cell(unusable.join('; '))}`]
      : []),
  ].join('\n'),
);

if (!usable.length) {
  console.error('no writable drive root: the probe cannot say anything');
  process.exitCode = 1;
}
