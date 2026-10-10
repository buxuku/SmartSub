import { execFile, type ExecFileException } from 'child_process';

/** execFile 失败的原因压成一行：超时、非零退出（带 stderr 第一行）、起不来。 */
export function describeCommandFailure(
  error: ExecFileException,
  stderr: unknown,
  timeoutMs: number,
): string {
  if (error.killed) return `timed out after ${timeoutMs} ms`;
  if (typeof error.code === 'number') {
    const line = String(stderr ?? '')
      .split(/\r?\n/)
      .map((text) => text.trim())
      .find(Boolean);
    return `exit code ${error.code}${line ? `: ${line.slice(0, 200)}` : ''}`;
  }
  return `could not start (${error.code ?? error.message})`;
}

/**
 * 跑外部命令取标准输出；失败（超时、非零退出、起不来）带着原因抛出。不弹控制台窗口。
 *
 * 命令只通过 argv 传入：不往子进程的 stdin 写任何东西（stdin 上的 EPIPE 是异步事件，
 * 调用方的 try/catch 接不住），也不会因为 stderr 上有输出就杀掉子进程。
 */
export function runCommandOrThrow(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(String(stdout));
          reject(new Error(describeCommandFailure(error, stderr, timeoutMs)));
        },
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
