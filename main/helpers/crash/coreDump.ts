/**
 * Linux：让崩溃的进程尽快退出，而不是等系统把 core 写完。只依赖 fs，不碰 electron。
 *
 * 问题：默认的管道式 core_pattern（systemd-coredump、apport）会让崩溃的进程一直等到 core 写完
 * 才退出。GitHub ubuntu-24.04 上实测（kernel 6.17，core_pattern=|systemd-coredump）：
 * 不做处理时主进程崩溃后 90 秒都没有退出（5 次里 5 次），用户看到的是窗口卡死而不是闪退；
 * 一个没有宿主加固的 utilityProcess 崩溃后 30 秒也没有上报。
 *
 * 做法：把 /proc/<pid>/coredump_filter 写成 0，系统 core 里不再带内存内容，只剩十几 KB。
 * 同步写、不需要外部命令，所以不像 prlimit 那样有“来不及”的竞态。proc(5) 写明该值会被 fork 继承、
 * 跨 execve 保留，所以主进程启动时写一次，之后由它启动的子进程（utilityProcess、ffmpeg、
 * python sidecar ……）也一并受益。
 *
 * 不影响 Crashpad 转储：转储由 crashReporter 的子进程在崩溃的信号处理里读取进程内存，
 * 与系统 core 无关。
 *
 * 取舍：不再留下带内存的系统 core。崩溃现场由 crashReporter 的转储提供，所以主进程只在
 * crashReporter 已经启动之后才这样做（见 crashReporting.ts）；要用 gdb 看完整的系统 core 时，
 * 设 SMARTSUB_KEEP_SYSTEM_CORE=true 保留系统默认。
 */
import fs from 'fs';

/** 回退开关：SMARTSUB_KEEP_SYSTEM_CORE=true 不缩小主进程的系统 core，保持系统默认。 */
export const KEEP_SYSTEM_CORE_ENV = 'SMARTSUB_KEEP_SYSTEM_CORE';

export type CoreDumpShrink =
  | { status: 'applied' }
  | { status: 'skipped'; reason: 'not-linux' | 'kept-by-env' }
  | { status: 'failed'; reason: string };

type WriteFile = (file: string, data: string) => void;

const defaultWriteFile: WriteFile = (file, data) =>
  fs.writeFileSync(file, data);

function failureText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code) return code;
  const message =
    error instanceof Error
      ? error.message.split('\n')[0]
      : String(error ?? '').split('\n')[0];
  return message || 'write failed';
}

/**
 * 把某个进程（pid，或 'self'）的 coredump_filter 写成 0。
 * 成功返回 null，失败返回原因文本，从不抛错。
 */
export function writeCoreDumpFilter(
  target: number | 'self',
  writeFile: WriteFile = defaultWriteFile,
): string | null {
  try {
    writeFile(`/proc/${target}/coredump_filter`, '0');
    return null;
  } catch (error) {
    return failureText(error);
  }
}

export interface CoreDumpDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  writeFile: WriteFile;
}

/** 缩小本进程（以及之后派生的子进程）的系统 core。只在 Linux 上做事，任何失败都只是返回原因。 */
export function shrinkOwnCoreDump(
  deps: Partial<CoreDumpDeps> = {},
): CoreDumpShrink {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== 'linux') return { status: 'skipped', reason: 'not-linux' };
  if (env[KEEP_SYSTEM_CORE_ENV] === 'true') {
    return { status: 'skipped', reason: 'kept-by-env' };
  }
  const failure = writeCoreDumpFilter('self', deps.writeFile);
  return failure === null
    ? { status: 'applied' }
    : { status: 'failed', reason: failure };
}

export interface CoreDumpLogLine {
  message: string;
  level: 'info' | 'warning';
}

/** 启动日志里的一行；Windows / macOS 上没有可说的，返回 null。 */
export function describeCoreDumpShrink(
  result: CoreDumpShrink,
): CoreDumpLogLine | null {
  switch (result.status) {
    case 'applied':
      return {
        message:
          'System core dumps of this process and its children are shrunk (coredump_filter=0); a crash exits promptly and the crashReporter dump is the record',
        level: 'info',
      };
    case 'skipped':
      return result.reason === 'kept-by-env'
        ? {
            message: `System core dumps kept at the system default (${KEEP_SYSTEM_CORE_ENV}=true); on systems that pipe core dumps a crashed process may take a long time to exit`,
            level: 'info',
          }
        : null;
    case 'failed':
      return {
        message: `Could not shrink the system core dump of this process (${result.reason}); on systems that pipe core dumps a crashed process may take a long time to exit`,
        level: 'warning',
      };
  }
}
