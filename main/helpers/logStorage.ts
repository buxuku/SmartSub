import fsp from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { LogEntry } from './store/types';

/** 日志保留天数（含今天） */
const RETENTION_DAYS = 7;
const DEFAULT_QUERY_LIMIT = 100;
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type LogType = NonNullable<LogEntry['type']>;

export type LogQuery = {
  /** YYYY-MM-DD（本地时区），默认当天 */
  date?: string;
  /** 返回尾部条数，默认 100 */
  limit?: number;
  /** 仅返回这些类型；缺省不过滤 */
  types?: LogType[];
  /** 仅返回该工程的日志 */
  projectId?: string;
};

function getLogsDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

/** 本地时区的 YYYY-MM-DD */
function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLogFilePath(date: string): string {
  return path.join(getLogsDir(), `${date}.jsonl`);
}

// 追加写经 promise 链串行化，保证多来源并发写入时的行序与行完整性
let writeChain: Promise<void> = Promise.resolve();

export function appendLog(entry: LogEntry): void {
  const line = JSON.stringify(entry) + '\n';
  const filePath = getLogFilePath(formatLocalDate(new Date(entry.timestamp)));
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(getLogsDir(), { recursive: true });
      await fsp.appendFile(filePath, line, 'utf-8');
    })
    .catch((error) => {
      // 日志写入失败不能影响业务流程，也不能再走 logMessage（会递归）
      console.error('[logStorage] append failed:', error);
    });
}

async function readLogFile(date: string): Promise<LogEntry[]> {
  let content: string;
  try {
    content = await fsp.readFile(getLogFilePath(date), 'utf-8');
  } catch {
    return [];
  }
  const entries: LogEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        entries.push(parsed as LogEntry);
      }
    } catch {
      // 坏行（如崩溃时写入的半行）直接跳过
    }
  }
  return entries;
}

/** 查询日志：按条件过滤后取尾部 limit 条，按时间升序返回 */
export async function queryLogs(query: LogQuery = {}): Promise<LogEntry[]> {
  const date = query.date || formatLocalDate(new Date());
  const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
  let entries = await readLogFile(date);
  if (query.types?.length) {
    const types = new Set<string>(query.types);
    entries = entries.filter((e) => types.has(e.type || 'info'));
  }
  if (query.projectId) {
    entries = entries.filter((e) => e.projectId === query.projectId);
  }
  return limit > 0 ? entries.slice(-limit) : entries;
}

/** 可查询的日期列表（降序，最新在前） */
export async function listLogDates(): Promise<string[]> {
  let files: string[];
  try {
    files = await fsp.readdir(getLogsDir());
  } catch {
    return [];
  }
  return files
    .map((f) => DATE_FILE_RE.exec(f)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort()
    .reverse();
}

/** 清空日志：无参删除全部文件；带 projectId 则逐文件重写过滤 */
export async function clearLogs(projectId?: string): Promise<void> {
  const dates = await listLogDates();
  for (const date of dates) {
    const filePath = getLogFilePath(date);
    if (!projectId) {
      await fsp.rm(filePath, { force: true });
      continue;
    }
    const entries = await readLogFile(date);
    const kept = entries.filter((e) => e.projectId !== projectId);
    if (kept.length === entries.length) continue;
    if (kept.length === 0) {
      await fsp.rm(filePath, { force: true });
    } else {
      await fsp.writeFile(
        filePath,
        kept.map((e) => JSON.stringify(e)).join('\n') + '\n',
        'utf-8',
      );
    }
  }
}

/** 删除超过保留期的日志文件，应用启动时调用（失败静默） */
export async function cleanupOldLogs(): Promise<void> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (RETENTION_DAYS - 1));
    const cutoffDate = formatLocalDate(cutoff);
    const dates = await listLogDates();
    for (const date of dates) {
      if (date < cutoffDate) {
        await fsp.rm(getLogFilePath(date), { force: true });
      }
    }
  } catch (error) {
    console.error('[logStorage] cleanup failed:', error);
  }
}
