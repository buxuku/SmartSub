/**
 * CPU 指令集探测的“真实依赖”：只用 Node 自带的 os / fs / child_process，不碰 electron，
 * 因此既能被应用使用，也能在 CI 的真机上直接跑（scripts/crash/probe-cpu.ts）验证。
 */
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { parseCpuCache, type CpuProbeDeps } from './cpuFeatures';

const SYSCTL = '/usr/sbin/sysctl';
const SYSCTL_TIMEOUT_MS = 3000;

export interface NodeProbeOptions {
  /** x64 进程是否在 ARM 转译下运行；Node 本身看不出来，由调用方（Electron）告知 */
  translated: boolean;
  /** Windows 探测结果的缓存文件；null 表示不缓存 */
  cacheFile: string | null;
}

/** 跑外部命令取标准输出；失败、超时、非零退出都返回 null。不弹控制台窗口。 */
export function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
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
        (error, stdout) => resolve(error ? null : String(stdout)),
      );
    } catch {
      resolve(null);
    }
  });
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
    run: runCommand,
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
