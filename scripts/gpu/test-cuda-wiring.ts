/**
 * cudaUtils 的接线：Windows 上 getGpuEnvironment() 只走单个 PowerShell 探测、绝不调用
 * systeminformation.graphics()；并发的调用共享同一次探测；探测失败时降级，并把原因写进日志。
 *
 * gpuEnumeration / singleFlightCache 自身的逻辑在各自的单测里验证。这里验证的是它们真的被
 * cudaUtils 用上了——以后谁把 si.graphics() 重新接回 Windows 的路径，这个测试会失败。
 *
 * cudaUtils 依赖 electron（经 storeManager / utils），所以沿用仓库里其他测试的办法：
 * 拦截 require，把这几个依赖换成桩；真实的 gpuEnumeration / singleFlightCache / nvidia-smi 探测照常运行。
 * 平台用 process.platform 伪装成 win32 / darwin，因此这个测试在任何系统上都能跑，
 * 也不会真的去起 PowerShell（run 被换成了可控的桩）。
 */
import Module from 'node:module';
import os from 'node:os';
import { assert, finish, test } from './testkit';

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | null,
  isMain: boolean,
) => unknown;
const moduleInternals = Module as unknown as { _load: Loader };
const originalLoad = moduleInternals._load;

interface RunCall {
  file: string;
  args: string[];
  timeoutMs: number;
}
type Graphics = {
  controllers: Array<{ model?: string; vendor?: string }>;
};

// —— 桩的状态：每个用例开始前重置 ——
let graphicsCalls = 0;
let runCalls: RunCall[] = [];
let logs: Array<{ level: string; message: string }> = [];
let graphicsImpl: () => Promise<Graphics> = async () => ({ controllers: [] });
let runImpl: (call: RunCall) => Promise<string> = async () => '';

function resetStubs() {
  graphicsCalls = 0;
  runCalls = [];
  logs = [];
  graphicsImpl = async () => ({ controllers: [] });
  runImpl = async () => '';
}

moduleInternals._load = function (request, parent, isMain) {
  // 只替换 cudaUtils 自己的依赖，别的模块要同名的相对路径时不受影响
  if (parent?.filename && /[\\/]cudaUtils\.[tj]s$/.test(parent.filename)) {
    if (request === 'systeminformation') {
      return {
        graphics: () => {
          graphicsCalls++;
          return graphicsImpl();
        },
      };
    }
    if (request === './storeManager') {
      return {
        logMessage: (message: string, level = 'info') => {
          logs.push({ level, message });
        },
      };
    }
    if (request === './utils') {
      return {
        getExtraResourcesPath: () => os.tmpdir(),
        isAppleSilicon: () => false,
      };
    }
    if (request === './runCommand') {
      return {
        runCommandOrThrow: (
          file: string,
          args: string[],
          timeoutMs: number,
        ) => {
          const call = { file, args, timeoutMs };
          runCalls.push(call);
          return runImpl(call);
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// 先把 stdout/stderr 建好：别让它们在伪装的平台下才第一次初始化
void process.stdout;
void process.stderr;

// 开发模拟开关会让 cudaUtils 直接返回模拟结果，绕开要测的路径
for (const name of Object.keys(process.env)) {
  if (name.startsWith('DEV_SIMULATE_')) delete process.env[name];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cudaUtils =
  require('../../main/helpers/cudaUtils') as typeof import('../../main/helpers/cudaUtils');

async function withPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(original, '拿不到 process.platform 的属性描述符');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const INTEL_ROW = 'GPU=Intel(R) UHD Graphics 630|Intel Corporation\r\n';

async function main() {
  const uncaught: Error[] = [];
  const onUncaught = (error: Error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);

  await test('Windows：并发的 getGpuEnvironment() 共享同一次探测，只起一个 PowerShell，从不调用 si.graphics()', async () => {
    resetStubs();
    cudaUtils.clearGpuEnvironmentCache();
    // 让探测在途一会儿，三路并发才会真正重叠（启动期就是这样：预热 + 渲染进程的几处 IPC）
    runImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return INTEL_ROW;
    };

    const environments = await withPlatform('win32', () =>
      Promise.all([
        cudaUtils.getGpuEnvironment(),
        cudaUtils.getGpuEnvironment(),
        cudaUtils.getGpuEnvironment(),
      ]),
    );

    assert.equal(runCalls.length, 1, '三路并发只应起一次 PowerShell');
    assert.equal(graphicsCalls, 0, 'Windows 上不应调用 si.graphics()');
    const [call] = runCalls;
    assert.match(
      call.file,
      /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i,
    );
    assert.deepEqual(call.args.slice(0, 3), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]);
    assert.match(call.args[3], /Get-CimInstance Win32_VideoController/);
    assert.ok(
      call.timeoutMs > 10_000,
      `探测预算 ${call.timeoutMs} ms 覆盖不了冷启动的 PowerShell`,
    );
    assert.equal(environments[0], environments[1]);
    assert.equal(environments[1], environments[2]);
    assert.ok(
      environments[0].gpus.some(
        (gpu) =>
          gpu.name === 'Intel(R) UHD Graphics 630' && gpu.vendor === 'intel',
      ),
      `应当解析出 Intel 显卡：${JSON.stringify(environments[0].gpus)}`,
    );
  });

  await test('Windows：算完后命中缓存；forceRefresh 和 clearGpuEnvironmentCache 都会重新探测', async () => {
    resetStubs();
    cudaUtils.clearGpuEnvironmentCache();
    runImpl = async () => INTEL_ROW;

    await withPlatform('win32', async () => {
      await cudaUtils.getGpuEnvironment();
      await cudaUtils.getGpuEnvironment();
      assert.equal(runCalls.length, 1, '第二次应命中缓存');

      await cudaUtils.getGpuEnvironment(true);
      assert.equal(runCalls.length, 2, 'forceRefresh 必须重新探测');

      // get-gpu-environment 的 IPC 处理就是这么用的：先 clear，再按 forceRefresh 取
      cudaUtils.clearGpuEnvironmentCache();
      await cudaUtils.getGpuEnvironment(true);
      assert.equal(runCalls.length, 3);

      cudaUtils.clearGpuEnvironmentCache();
      await cudaUtils.getGpuEnvironment();
      assert.equal(runCalls.length, 4, 'clear 之后的下一次调用应重新探测');
    });
    assert.equal(graphicsCalls, 0);
  });

  await test('Windows：探测失败 → getGpuEnvironment() 不抛错，失败原因写进警告日志', async () => {
    resetStubs();
    cudaUtils.clearGpuEnvironmentCache();
    runImpl = async () => {
      throw new Error('exit code 1: Access is denied');
    };

    const environment = await withPlatform('win32', () =>
      cudaUtils.getGpuEnvironment(),
    );

    assert.equal(runCalls.length, 1);
    assert.equal(graphicsCalls, 0, '探测失败也不能退回 si.graphics()');
    assert.ok(Array.isArray(environment.gpus));
    const warning = logs.find(
      (entry) =>
        entry.level === 'warning' &&
        /GPU enumeration failed: .*Windows GPU probe failed: exit code 1: Access is denied/.test(
          entry.message,
        ),
    );
    assert.ok(
      warning,
      `应当有带原因的 GPU enumeration failed 警告：${JSON.stringify(logs)}`,
    );
  });

  await test('非 Windows：沿用 si.graphics()，不起 PowerShell', async () => {
    resetStubs();
    cudaUtils.clearGpuEnvironmentCache();
    graphicsImpl = async () => ({
      controllers: [{ model: 'Intel Iris Plus', vendor: 'Intel' }],
    });

    const environment = await withPlatform('darwin', () =>
      cudaUtils.getGpuEnvironment(),
    );

    assert.equal(graphicsCalls, 1);
    assert.equal(runCalls.length, 0, '非 Windows 不应起 PowerShell');
    assert.deepEqual(environment.gpus, [
      { name: 'Intel Iris Plus', vendor: 'intel' },
    ]);
  });

  process.off('uncaughtException', onUncaught);
  moduleInternals._load = originalLoad;
  assert.deepEqual(
    uncaught.map((error) => error.message),
    [],
    '整个套件期间不应有未捕获异常',
  );
  finish('cudaUtils 接线');
}

void main();
