/**
 * CPU 指令集探测的“真实依赖”：只用 Node 自带的 os / fs / child_process，不碰 electron，
 * 因此既能被应用使用，也能在 CI 的真机上直接跑（scripts/crash/probe-cpu.ts）验证。
 */
import fs from 'fs';
import os from 'os';
import { execFile, type ExecFileException } from 'child_process';
import { parseCpuCache, type CpuProbeDeps } from './cpuFeatures';

const SYSCTL = '/usr/sbin/sysctl';
const SYSCTL_TIMEOUT_MS = 3000;

export interface NodeProbeOptions {
  /** x64 进程是否在 ARM 转译下运行；Node 本身看不出来，由调用方（Electron）告知 */
  translated: boolean;
  /** Windows 探测结果的缓存文件；null 表示不缓存 */
  cacheFile: string | null;
}

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

/** 跑外部命令取标准输出；失败（超时、非零退出、起不来）带着原因抛出。不弹控制台窗口。 */
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

/** 跑外部命令取标准输出；失败、超时、非零退出都返回 null。不弹控制台窗口。 */
export function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return runCommandOrThrow(file, args, timeoutMs).catch(() => null);
}

export function createNodeProbeDeps(options: NodeProbeOptions): CpuProbeDeps {
  const { cacheFile } = options;
  return {
    platform: process.platform,
    arch: process.arch,
    translated: options.translated,
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model?.trim() || null,
    readFile: async (file) => {
      try {
        return await fs.promises.readFile(file, 'utf8');
      } catch {
        return null;
      }
    },
    sysctl: async (key) => {
      const out = await runCommand(SYSCTL, ['-n', key], SYSCTL_TIMEOUT_MS);
      return out === null ? null : out.trim();
    },
    // 探测报告的 note 要写失败原因，所以这里用会抛错的版本（sysctl 仍走返回 null 的 runCommand）
    run: runCommandOrThrow,
    ...(cacheFile
      ? {
          cache: {
            read: () => {
              try {
                return parseCpuCache(fs.readFileSync(cacheFile, 'utf8'));
              } catch {
                return null;
              }
            },
            write: (entry) => {
              fs.writeFileSync(cacheFile, JSON.stringify(entry));
            },
          },
        }
      : {}),
    now: Date.now,
    systemRoot: process.env.SystemRoot,
  };
}
