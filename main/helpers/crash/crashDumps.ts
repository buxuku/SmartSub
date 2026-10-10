/**
 * 崩溃转储文件的枚举与保留策略（不依赖 electron）。
 *
 * 目录结构（PoC 在 CI 上实测）：
 * - Windows：{crashDumps}/reports/<uuid>.dmp，另有 settings.dat、metadata
 * - Linux / macOS：{crashDumps}/pending/<uuid>.dmp 与同名 .meta，另有 settings.dat、client_id
 * 所以递归扫描 *.dmp，清理时连同同名 .meta 一起删。
 *
 * 保留策略的由来：实测 Windows 主进程转储约 34 MB，子进程只有 0.4-0.8 MB；
 * 不清理的话反复崩溃会不断涨盘。
 */
import fs from 'fs';
import path from 'path';

export const DUMP_MAX_FILES = 5;
export const DUMP_MAX_BYTES = 150 * 1024 * 1024;

export interface DumpFile {
  file: string;
  size: number;
  mtimeMs: number;
}

const MAX_DEPTH = 4;

function walk(dir: string, depth: number, out: DumpFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) walk(full, depth + 1, out);
    } else if (entry.isFile() && /\.dmp$/i.test(entry.name)) {
      try {
        const stat = fs.statSync(full);
        out.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 枚举与读取之间被删除，跳过
      }
    }
  }
}

/** 递归列出 .dmp，最新的在前。目录不存在返回空数组。 */
export function listDumpFiles(dir: string): DumpFile[] {
  const out: DumpFile[] = [];
  walk(dir, 0, out);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface PruneDumpLimits {
  maxFiles?: number;
  maxBytes?: number;
}

export interface PruneDumpResult {
  kept: number;
  removed: string[];
}

function removeDump(file: string): boolean {
  let ok = true;
  const metaFile = file.replace(/\.dmp$/i, '.meta');
  for (const target of [file, metaFile]) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * 只保留最新的若干个，且总量不超过上限；最新的一个永远保留（哪怕它自己超过上限），
 * 因为它最可能是用户马上要反馈的那次崩溃。失败静默。
 */
export function pruneDumpFiles(
  dir: string,
  limits: PruneDumpLimits = {},
): PruneDumpResult {
  const maxFiles = limits.maxFiles ?? DUMP_MAX_FILES;
  const maxBytes = limits.maxBytes ?? DUMP_MAX_BYTES;
  const dumps = listDumpFiles(dir);
  const removed: string[] = [];
  let kept = 0;
  let total = 0;
  for (const dump of dumps) {
    const withinCount = kept < maxFiles;
    const withinBytes = total + dump.size <= maxBytes;
    if (kept === 0 || (withinCount && withinBytes)) {
      kept++;
      total += dump.size;
      continue;
    }
    if (removeDump(dump.file)) removed.push(dump.file);
    else {
      // 删不掉（被占用或权限不足）：仍然算占用空间，让后面的更旧文件继续被清理
      kept++;
      total += dump.size;
    }
  }
  return { kept, removed };
}
