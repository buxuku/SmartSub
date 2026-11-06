#!/usr/bin/env node
/**
 * issue #590 回归（断言）：视频位于盘符根目录时，「导出字幕」阶段的发布流程必须能成功。
 *
 * 跑的是应用里真正的实现，不是拷贝（经 ../windows-nonascii/ts-require.cjs 直接加载 .ts 源码）。
 * 调用链与 main/helpers/taskRuns/adapters.ts 一致：
 *   exportSubtitles()  desired = path.join(<视频所在目录>, `${name}.srt`)
 *   publish()          createComposeOutput(desired, [视频]) → copyIndependent(源字幕, output.staged)
 *                      → output.publish() → output.cleanup()
 * <视频所在目录> 即 wrapFileObject().directory = path.dirname(filePath)：视频在 F:\ 根目录时就是 `F:\`。
 *
 * 每个可写的卷根上跑三组：
 *   - 视频直接在盘符根目录（#590 的场景）；
 *   - 视频在盘符根目录下的子文件夹（对照，用户报告这种情况一切正常）；
 *   - ensureDirectorySync 直接作用于卷根和卷根下尚不存在的目录（下载目录 videoDownload/scheduler.ts
 *     用的是同一个原语）。
 * 修复前（createComposeOutput 里直接 fs.mkdirSync(parent, { recursive: true })），第一组在
 * `EPERM: operation not permitted, mkdir 'D:\\'` 处失败，其余通过；修复后全部应通过，
 * 且不留下 .smartsub-compose-* 暂存目录。
 *
 * 非 Windows 没有盘符根目录，直接跳过（DRIVE_ROOTS 指定目录可以在本地演练脚本本身）。
 * 退出码：任何断言失败即非 0。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  RUN_ID,
  appendSummary,
  cell,
  createChecks,
  describeError,
  driveRoots,
  fileSystemOf,
  machineInfo,
  writableRoot,
} from './lib.mjs';

const require = createRequire(import.meta.url);
const { requireRepoTs } = require('../windows-nonascii/ts-require.cjs');
const { createComposeOutput } = requireRepoTs(
  'main/helpers/compose/composeOutput.ts',
);
const { ensureDirectorySync } = requireRepoTs(
  'main/helpers/ensureDirectory.ts',
);
const { copyIndependent } = requireRepoTs('main/helpers/taskRuns/artifacts.ts');

const SRT = '1\n00:00:00,000 --> 00:00:01,000\nhello\n';
const isWindows = process.platform === 'win32';
const sameFile = (a, b) =>
  isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;

console.log(
  `machine: ${JSON.stringify({ ...machineInfo(), libuv: process.versions.uv })}`,
);

const roots = driveRoots();
if (!roots.length) {
  console.log(
    'SKIP  no drive roots on this platform (drive letters exist only on Windows; set DRIVE_ROOTS to rehearse)',
  );
  process.exit(0);
}

/** adapters.ts 里 publish() 的调用链（verifyInput 钩子只在任务上下文里存在，这里省略）。 */
async function publishLikeExportStage(source, desired, inputs) {
  const output = createComposeOutput(desired, inputs);
  try {
    await copyIndependent(source, output.staged);
    return await output.publish(new AbortController().signal);
  } finally {
    output.cleanup();
  }
}

const checks = createChecks();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-issue590-'));
let counter = 0;

async function runCase(label, videoDir, { precreate }) {
  const id = `${RUN_ID}-${counter++}`;
  const made = [];
  try {
    if (precreate) {
      fs.mkdirSync(videoDir);
      made.push(videoDir);
    }
    const video = path.join(videoDir, `${id}.mp4`);
    fs.writeFileSync(video, 'video bytes', { flag: 'wx' });
    made.push(video);
    // wrapFileObject().directory，以及 exportSubtitles() 里的 desired
    const directory = path.dirname(video);
    const desired = path.join(directory, `${id}.srt`);
    const source = path.join(scratch, `${id}.srt`);
    fs.writeFileSync(source, SRT);

    let published;
    try {
      published = await publishLikeExportStage(source, desired, [video]);
    } catch (error) {
      console.log(
        String(error.stack || error)
          .split('\n')
          .slice(0, 6)
          .join('\n'),
      );
      checks.check(label, false, `export threw ${describeError(error)}`);
      return;
    }
    made.push(published);

    const problems = [];
    if (!sameFile(published, desired))
      problems.push(`published to ${published}, expected ${desired}`);
    if (!fs.existsSync(published) || fs.readFileSync(published, 'utf8') !== SRT)
      problems.push('published subtitle is missing or has different content');
    if (fs.readFileSync(video, 'utf8') !== 'video bytes')
      problems.push('the source video was modified');
    const leftovers = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith('.smartsub-compose-'));
    if (leftovers.length)
      problems.push(`left staging directories behind: ${leftovers.join(', ')}`);
    checks.check(
      label,
      problems.length === 0,
      problems.join('; ') || `published ${published}`,
    );
  } finally {
    // 先清暂存目录（失败的运行可能留下），再删本用例创建的文件和子目录
    if (fs.existsSync(videoDir))
      for (const entry of fs.readdirSync(videoDir, { withFileTypes: true }))
        if (entry.isDirectory() && entry.name.startsWith('.smartsub-compose-'))
          fs.rmSync(path.join(videoDir, entry.name), {
            recursive: true,
            force: true,
          });
    for (const item of made.reverse())
      fs.rmSync(item, { recursive: true, force: true });
  }
}

/** 下载目录（videoDownload/scheduler.ts）用的同一个原语：卷根本身，以及卷根下尚不存在的多级目录。 */
function checkEnsureDirectory(root, volume) {
  const top = path.join(root, `${RUN_ID}-ensure`);
  const nested = path.join(top, 'a', 'b');
  try {
    try {
      ensureDirectorySync(root);
      checks.check(
        `ensureDirectorySync on the existing drive root ${root} (${volume})`,
        true,
        'no error',
      );
    } catch (error) {
      checks.check(
        `ensureDirectorySync on the existing drive root ${root} (${volume})`,
        false,
        `threw ${describeError(error)}`,
      );
    }
    try {
      ensureDirectorySync(nested);
      ensureDirectorySync(nested);
      checks.check(
        `ensureDirectorySync creates missing folders under ${root}  [control]`,
        fs.statSync(nested).isDirectory(),
        nested,
      );
    } catch (error) {
      checks.check(
        `ensureDirectorySync creates missing folders under ${root}  [control]`,
        false,
        `threw ${describeError(error)}`,
      );
    }
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
}

let usable = 0;
try {
  for (const root of roots) {
    const volume = fileSystemOf(root) ?? 'unknown';
    console.log(`\n== ${root} (file system: ${volume}) ==`);
    const writable = writableRoot(root);
    if (!writable.ok) {
      checks.note(
        `skip ${root}: not writable by this account (${writable.reason})`,
      );
      continue;
    }
    usable++;
    await runCase(
      `export with the video in the drive root ${root} (${volume})`,
      root,
      {
        precreate: false,
      },
    );
    await runCase(
      `export with the video in a sub-folder of ${root} (${volume})  [control]`,
      path.join(root, `${RUN_ID}-dir`),
      { precreate: true },
    );
    checkEnsureDirectory(root, volume);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (!usable) {
  checks.check('at least one writable drive root', false, 'nothing to test');
}

appendSummary(
  [
    `### Export at a drive root (Node ${process.version}, libuv ${process.versions.uv})`,
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...checks.rows.map(
      (row) =>
        `| ${cell(row.name)} | ${row.ok ? 'PASS' : 'FAIL'} | ${cell(row.detail)} |`,
    ),
  ].join('\n'),
);
process.exitCode = checks.failed ? 1 : 0;
