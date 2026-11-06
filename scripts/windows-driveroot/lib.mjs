/**
 * 盘符根目录脚本的共用工具（issue #590：视频放在 F:\ 根目录，导出字幕阶段 mkdir 失败）。
 *
 * 背景：导出字幕时，应用在 createComposeOutput 里对输出文件的父目录执行
 * fs.mkdirSync(parent, { recursive: true })。视频在盘符根目录时，父目录就是卷根（F:\）。
 * Windows 的 CreateDirectory 对「已存在的卷根」返回 ERROR_ACCESS_DENIED，而不是
 * ERROR_ALREADY_EXISTS；libuv 把它映射成 EPERM，Node 的递归 mkdir 只吞掉 EEXIST，
 * 于是抛出 `EPERM: operation not permitted, mkdir 'F:\'`。Node 官方文档（fs.mkdir）对此有说明。
 * 放进任何子目录后，目标目录返回的是「已存在」，一切正常。
 *
 * 必须用「真实的卷根」：subst 出来的盘符其实指向一个普通目录，CreateDirectory 会返回
 * 「已存在」，复现不了。GitHub 托管的 windows runner 上 C:\ 与 D:\ 都是真实卷，runner 账户可写。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export {
  appendSummary,
  createChecks,
  machineInfo,
} from '../windows-nonascii/lib.mjs';

/** 本次运行的唯一前缀：不会和根目录里已有的文件重名，也便于残留清理。 */
export const RUN_ID = `smartsub-issue590-${process.pid}-${Date.now().toString(36)}`;

/** 把 fs 错误压成一行：code (syscall) path: message。 */
export function describeError(error) {
  const e = error ?? {};
  const head = [e.code, e.syscall && `(${e.syscall})`]
    .filter(Boolean)
    .join(' ');
  return `${head ? `${head}: ` : ''}${e.message ?? String(error)}`;
}

/**
 * 候选的「盘符根目录」。Windows 上枚举 A:\ … Z:\ 中存在的卷；
 * DRIVE_ROOTS（分号分隔）用于在非 Windows 上本地演练脚本本身。
 */
export function driveRoots() {
  if (process.env.DRIVE_ROOTS) {
    return process.env.DRIVE_ROOTS.split(';')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (process.platform !== 'win32') return [];
  const roots = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.statSync(root).isDirectory()) roots.push(root);
    } catch {
      /* 该盘符不存在或介质不可用 */
    }
  }
  return roots;
}

/** 在 root 下建一个文件再删掉，确认当前账户能写；不能写的卷无法用于复现。 */
export function writableRoot(root) {
  const file = path.join(root, `${RUN_ID}-writable.tmp`);
  try {
    fs.writeFileSync(file, 'x', { flag: 'wx' });
    fs.rmSync(file, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

/** 卷的文件系统（NTFS / exFAT / ReFS ...），仅作信息；取不到返回 null。 */
export function fileSystemOf(root) {
  if (process.platform !== 'win32') return null;
  const letter = /^([A-Za-z]):/.exec(root)?.[1];
  if (!letter) return null;
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Volume -DriveLetter ${letter}).FileSystem`,
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  const text = (r.stdout || '').trim();
  return r.status === 0 && text ? text : null;
}

/** Markdown 表格单元：转义竖线，避免破坏表格。 */
export function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
