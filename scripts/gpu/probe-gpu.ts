/**
 * 真机上的 GPU 枚举检查（CI 的 Windows runner 上跑；在自己的机器上也可以直接跑）。
 *
 * 单测里 Windows 的探测用的是 node 子进程充当 PowerShell；这里用真实的 powershell.exe 跑一遍
 * Win32_VideoController 查询，确认真实的命令行转义、输出编码、输出格式都能被解析，耗时在预期内，
 * 并且从头到尾没有未捕获异常（systeminformation 在 Windows 上弹 write EPIPE 正是未捕获异常的形态）。
 * Linux / macOS 沿用 systeminformation.graphics()，这里用真实的库跑一遍，确认没被改坏。
 *
 * 用法：tsx scripts/gpu/probe-gpu.ts
 * 退出码：0 通过；1 有断言失败。机器上没有显卡（CI 的虚拟机很常见）不算失败，只打印提示。
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import * as si from 'systeminformation';
import {
  buildWindowsGpuProbeCommand,
  enumerateGenericGpus,
  parseWindowsGpuProbeOutput,
  WINDOWS_GPU_PROBE_TIMEOUT_MS,
} from '../../main/helpers/gpuEnumeration';
import { runCommandOrThrow } from '../../main/helpers/runCommand';

/** 比这慢只给提示，不算失败（PowerShell 冷启动慢是环境问题，不是探测的缺陷） */
const WINDOWS_SLOW_PROBE_MS = 5_000;

const failures: string[] = [];
function expect(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures.push(message);
    console.error(`  ✗ ${message}`);
  }
}

interface Captured {
  code: number | string;
  killed: boolean;
  stdout: string;
  stderr: string;
  ms: number;
}

/** 与生产路径同样的参数，但把 stderr 也留下来：想知道真机上的 PowerShell 有没有往 stderr 写东西。 */
function capture(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<Captured> {
  return new Promise((resolve) => {
    const started = Date.now();
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
        resolve({
          code: error ? ((error as { code?: number | string }).code ?? 1) : 0,
          killed: !!(error && error.killed),
          stdout: String(stdout),
          stderr: String(stderr),
          ms: Date.now() - started,
        });
      },
    );
  });
}

async function probeWindows(): Promise<void> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const { file, args } = buildWindowsGpuProbeCommand(systemRoot);
  console.log(`命令：${file}`);
  console.log(`脚本：${args[3]}`);

  let run = await capture(file, args, WINDOWS_GPU_PROBE_TIMEOUT_MS);
  let retried = false;
  const report = (label: string, result: Captured) => {
    console.log(
      `\n${label}（${result.ms} ms）：exit=${result.code}${result.killed ? ' 超时被终止' : ''}`,
    );
    console.log(`  stdout: ${JSON.stringify(result.stdout)}`);
    console.log(`  stderr: ${JSON.stringify(result.stderr)}`);
  };
  report('首次运行', run);
  // 冷启动要多久是调预算的依据：真机上第一次启动曾超过 10 秒，之后只要零点几秒到几秒。
  // 这里无论成败都记下来，不用翻日志
  console.log(
    `::notice::Windows 上 PowerShell 显卡探测首次运行 ${run.ms} ms（预算 ${WINDOWS_GPU_PROBE_TIMEOUT_MS} ms，${run.code === 0 ? '成功' : '失败'}）`,
  );

  if (run.code !== 0) {
    // 冷启动偶发很慢：重试一次，区分“偶发的冷启动慢”和“命令本身不行”。
    // 应用里没有重试：失败会降级并把原因写进日志，降级后的结果在本次会话内保持。
    console.log('\n首次运行没有成功，重试一次……');
    run = await capture(file, args, WINDOWS_GPU_PROBE_TIMEOUT_MS);
    retried = true;
    report('重试', run);
  }
  if (run.code === 0 && (retried || run.ms > WINDOWS_SLOW_PROBE_MS)) {
    console.log(
      `::warning::Windows 上 PowerShell 显卡探测偏慢或首次失败（${retried ? '重试后' : '最终'} ${run.ms} ms）：冷启动慢是环境因素`,
    );
  }
  if (run.stderr.trim()) {
    // systeminformation 遇到 stderr 上的任何输出都会 kill 子进程，随后排队的 stdin 写入就是 EPIPE
    console.log(
      `::notice::PowerShell 在 stderr 上有输出（systeminformation 会因此 kill 子进程）：${JSON.stringify(run.stderr.slice(0, 300))}`,
    );
  }

  console.log('\n断言：');
  expect(run.code === 0, 'Windows：PowerShell 探测命令正常退出（exit 0）');
  const gpus = parseWindowsGpuProbeOutput(run.stdout);
  console.log(`  解析结果：${JSON.stringify(gpus)}`);
  expect(
    gpus.length > 0 || run.stdout.trim() === '',
    'Windows：stdout 非空时能解析出至少一块显卡（没有任何 GPU= 行说明格式或编码不对）',
  );
  expect(
    gpus.every((gpu) => gpu.model.length > 0),
    'Windows：每块显卡都有名称',
  );
  if (run.code === 0 && gpus.length === 0) {
    console.log(
      '::warning::这台机器上没有枚举到任何显卡（CI 虚拟机偶有）：探测命令本身可用，但没有对照数据',
    );
  }

  // 生产入口（enumerateGenericGpus → probeWindowsGpus → runCommandOrThrow）与上面直接跑的结果应一致。
  // 它失败时抛错：记成一项失败，不能让异常把整个检查带走
  const started = Date.now();
  try {
    const viaApi = await enumerateGenericGpus({
      platform: 'win32',
      siGraphics: () =>
        Promise.reject(new Error('Windows 上不应该调用 si.graphics()')),
      run: runCommandOrThrow,
      systemRoot,
    });
    console.log(`\n生产入口再跑一次（${Date.now() - started} ms）`);
    expect(
      JSON.stringify(viaApi) === JSON.stringify(gpus),
      'Windows：生产入口与直接解析的结果一致',
    );
  } catch (error) {
    expect(
      false,
      `Windows：生产入口没有抛错（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

async function probeOthers(): Promise<void> {
  const started = Date.now();
  const gpus = await enumerateGenericGpus({
    platform: process.platform,
    siGraphics: () => si.graphics(),
    run: runCommandOrThrow,
  });
  console.log(
    `\nsystemInformation.graphics()（${Date.now() - started} ms）：${JSON.stringify(gpus)}`,
  );
  console.log('\n断言：');
  expect(Array.isArray(gpus), `${process.platform}：返回的是数组，没有抛错`);
  expect(
    gpus.every((gpu) => gpu.model.length > 0 || gpu.vendor.length > 0),
    `${process.platform}：没有型号也没有厂商的条目被过滤掉了`,
  );
  if (gpus.length === 0) {
    console.log(
      '::warning::这台机器上没有枚举到任何显卡（CI 虚拟机常见）：流程可用，但没有对照数据',
    );
  }
}

async function main() {
  // 整个检查期间，任何未捕获异常都视为失败（这正是线上弹窗的形态）
  const uncaught: Error[] = [];
  process.on('uncaughtException', (error) => uncaught.push(error));
  process.on('unhandledRejection', (reason) =>
    uncaught.push(reason instanceof Error ? reason : new Error(String(reason))),
  );

  const cpus = os.cpus();
  console.log(
    `GPU 枚举真机检查 · ${process.platform}/${process.arch} · ${os.release()} · ${cpus[0]?.model?.trim()} x${cpus.length}`,
  );

  try {
    if (process.platform === 'win32') {
      await probeWindows();
    } else {
      await probeOthers();
    }
  } catch (error) {
    // 任何意外都必须落成失败：绝不能悄悄结束进程、让 CI 误以为通过
    expect(
      false,
      `检查过程中抛出异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }

  // 给任何迟到的异步 'error' 事件留出浮现的时间
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(uncaught.length === 0, '全程没有未捕获异常');
  if (uncaught.length > 0) {
    console.error(uncaught.map((error) => error.stack).join('\n'));
  }

  if (failures.length > 0) {
    console.error(
      `\n探测检查失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`,
    );
    process.exit(1);
  }
  console.log('\n探测检查通过');
}

// main 自己的异常也要让进程以非零退出：不能因为 void 掉 Promise 而静默通过
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
