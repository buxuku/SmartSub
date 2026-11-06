/**
 * crash-events.jsonl：崩溃事件的持久化记录（同步追加，不依赖 electron）。
 *
 * 为什么单独存而不放进每日日志：应用日志只保留 7 天，而用户往往隔很久才来反馈；
 * 崩溃事件很少、很小，保留 30 天。文件放在 logs/ 目录下，但文件名不符合“日期.jsonl”，
 * 所以不会被日志的 7 天清理和“清空日志”误删。
 *
 * 写入全程同步并吞掉异常：崩溃处理路径上不能再抛错，也不能依赖异步写入是否来得及完成。
 */
import fs from 'fs';
import path from 'path';
import type { ExitClassification } from './exitClassifier';
import type { CrashContextEntry } from './crashContext';

export const EVENTS_MAX_BYTES = 1024 * 1024;
export const EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type CrashEventSource =
  | 'child-process-gone'
  | 'render-process-gone'
  | 'uncaught-exception'
  | 'utility-exit'
  | 'previous-run';

export interface CrashEvent {
  ts: number;
  source: CrashEventSource;
  /** Electron 进程类型：Utility、GPU、Tab、Browser 等 */
  processType?: string;
  /** Chromium 的服务名（utilityProcess 恒为 node.mojom.NodeService），不是我们设置的那个 */
  serviceName?: string;
  /** utilityProcess.fork 时我们传入的 serviceName 会出现在这里（实测） */
  name?: string;
  reason?: string;
  exitCode?: number;
  classification?: ExitClassification;
  /** 事件发生时正在进行的引擎、模型、后端、阶段 */
  context?: CrashContextEntry[];
  /** 未捕获异常的错误名、消息与栈顶（已脱敏、已截断） */
  errorName?: string;
  message?: string;
  stack?: string;
  /** 补充说明，例如 previous-run 事件的依据 */
  detail?: string;
  appVersion?: string;
  platform?: string;
  arch?: string;
}

/** 当前文件对应的轮转文件：crash-events.jsonl → crash-events.1.jsonl */
export function rotatedFileOf(file: string): string {
  const ext = path.extname(file);
  return file.slice(0, file.length - ext.length) + '.1' + ext;
}

/** 追加一条事件；超过大小上限先轮转。永不抛错，成功返回 true。 */
export function appendCrashEvent(
  file: string,
  event: CrashEvent,
  maxBytes: number = EVENTS_MAX_BYTES,
): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // 文件还不存在
    }
    if (size >= maxBytes) {
      try {
        // Windows 与 POSIX 的 rename 都会覆盖已有的轮转文件
        fs.renameSync(file, rotatedFileOf(file));
      } catch {
        // 轮转失败就继续追加，宁可文件变大也不丢事件
      }
    }
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    return true;
  } catch (error) {
    console.error('[crash] failed to append crash event:', error);
    return false;
  }
}

function parseLines(content: string): CrashEvent[] {
  const events: CrashEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.ts === 'number' &&
        typeof parsed.source === 'string'
      ) {
        events.push(parsed as CrashEvent);
      }
    } catch {
      // 半行或坏行（崩溃时正在写入）直接跳过
    }
  }
  return events;
}

function readOne(file: string): CrashEvent[] {
  try {
    return parseLines(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

export interface ReadCrashEventsOptions {
  /** 只要不早于该时间戳（毫秒）的事件 */
  sinceTs?: number;
  /** 取最新的 N 条 */
  limit?: number;
}

/** 读取事件（含轮转文件），按时间升序。文件不存在返回空数组。 */
export function readCrashEvents(
  file: string,
  options: ReadCrashEventsOptions = {},
): CrashEvent[] {
  let events = [...readOne(rotatedFileOf(file)), ...readOne(file)];
  if (typeof options.sinceTs === 'number') {
    const since = options.sinceTs;
    events = events.filter((e) => e.ts >= since);
  }
  events.sort((a, b) => a.ts - b.ts);
  if (options.limit && options.limit > 0) events = events.slice(-options.limit);
  return events;
}

/**
 * 删除超过保留期的事件。没有需要删除的内容时不改动文件；失败静默。
 * 重写用“临时文件 + 重命名”，避免中途退出留下半个文件。
 */
export function pruneCrashEvents(
  file: string,
  now: number = Date.now(),
  retentionMs: number = EVENTS_RETENTION_MS,
): void {
  const cutoff = now - retentionMs;
  for (const target of [rotatedFileOf(file), file]) {
    try {
      if (!fs.existsSync(target)) continue;
      const content = fs.readFileSync(target, 'utf8');
      const nonEmptyLines = content.split('\n').filter((l) => l.trim()).length;
      const kept = parseLines(content).filter((e) => e.ts >= cutoff);
      if (kept.length === nonEmptyLines) continue;
      if (kept.length === 0) {
        fs.rmSync(target, { force: true });
        continue;
      }
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(
        tmp,
        kept.map((e) => JSON.stringify(e)).join('\n') + '\n',
        'utf8',
      );
      fs.renameSync(tmp, target);
    } catch (error) {
      console.error('[crash] failed to prune crash events:', error);
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把用户目录等前缀替换成 ~，避免诊断信息里带出用户名。
 * 同时处理正反斜杠与 JSON 转义后的双反斜杠；忽略大小写（Windows 与 macOS 的文件系统不区分）。
 */
export function createPathRedactor(
  roots: Array<string | undefined>,
): (text: string) => string {
  const variants = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    const trimmed = root.replace(/[\\/]+$/, '');
    // 太短的前缀（如 /、C:）会把无关内容也替换掉
    if (trimmed.length < 3) continue;
    variants.add(trimmed);
    variants.add(trimmed.replace(/\\/g, '/'));
    variants.add(trimmed.replace(/\//g, '\\'));
    variants.add(trimmed.replace(/\\/g, '\\\\'));
  }
  const patterns = [...variants]
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(escapeRegExp(v), 'gi'));
  return (text: string) =>
    patterns.reduce((acc, re) => acc.replace(re, '~'), text);
}
