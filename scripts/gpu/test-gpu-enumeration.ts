/**
 * GPU 枚举：Windows 不能再走 systeminformation.graphics()。
 *
 * 背景：graphics() 在 Windows 上一次拉起 7 个 PowerShell，并往每个子进程的 stdin 写命令
 * （write → write('exit') → end()），却从不给 stdin 挂 'error' 监听，而且 PowerShell 的 stderr 上
 * 只要有任何输出它就 child.kill()。子进程在排队的第二次写入发出之前没了（退出、被杀……），
 * 这次写入就会遇到 EPIPE，那是主进程里没人接的 'error' 事件：弹出 “A JavaScript error occurred
 * in the main process: Error: write EPIPE”，调用方的 try/catch / Promise.race / .catch() 全都拦不住。
 *
 * 新的做法：只起一个 PowerShell，命令走 argv，不写 stdin，不因为 stderr 杀进程。
 * 这里用真实的子进程（node 充当“PowerShell”）验证各种“提前退出 / 满嘴 stderr / 卡住”都安全。
 */
import {
  buildWindowsGpuProbeCommand,
  enumerateGenericGpus,
  parseWindowsGpuProbeOutput,
  probeWindowsGpus,
  WINDOWS_GPU_PROBE_TIMEOUT_MS,
  type RunCommand,
} from '../../main/helpers/gpuEnumeration';
import { runCommandOrThrow } from '../../main/helpers/runCommand';
import { assert, finish, test } from './testkit';

const NO_SI = async () => {
  throw new Error('systeminformation.graphics() 不应该被调用');
};

/**
 * 用真实的 runCommandOrThrow 跑一段 node 脚本，充当“PowerShell”，忽略探测命令本身。
 * 脚本里只用单引号：不依赖各平台对 argv 里双引号的转义。
 */
const runViaNode =
  (script: string): RunCommand =>
  (_file, _args, timeoutMs) =>
    runCommandOrThrow(process.execPath, ['-e', script], timeoutMs);

async function main() {
  // 整个套件期间，任何未捕获异常都视为失败（这正是线上弹窗的形态）
  const uncaught: Error[] = [];
  const onUncaught = (error: Error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);

  await test('探测命令：绝对路径的 powershell、明文 -Command（不用 -EncodedCommand / -ExecutionPolicy）', () => {
    const { file, args } = buildWindowsGpuProbeCommand('D:\\Win');
    assert.equal(
      file,
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    assert.deepEqual(args.slice(0, 3), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]);
    assert.equal(args.length, 4, '脚本应当作为单个参数');
    for (const risky of ['-EncodedCommand', '-ExecutionPolicy', '-File']) {
      assert.ok(!args.includes(risky), `不应使用 ${risky}（容易被杀软盯上）`);
    }
    assert.match(args[3], /Get-CimInstance Win32_VideoController/);
    assert.match(
      args[3],
      /\$ProgressPreference = 'SilentlyContinue'/,
      '关掉进度记录：stdout 被重定向时它们会以 CLIXML 写到 stderr',
    );
    assert.ok(
      !args[3].includes('"'),
      '脚本里不能有双引号，否则 Windows 命令行转义会把它改坏',
    );
  });

  await test('探测命令：没给 SystemRoot 时用 C:\\Windows', () => {
    assert.equal(
      buildWindowsGpuProbeCommand().file,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  await test('解析：每行 GPU=名称|厂商；BOM、CRLF、噪声行、空记录都不影响', () => {
    const output =
      '\uFEFFGPU=NVIDIA GeForce RTX 3060|NVIDIA\r\n' +
      'some warning text\r\n' +
      'GPU=Intel(R) UHD Graphics 630|Intel Corporation\r\n' +
      'GPU=|\r\n' +
      '\r\n' +
      'GPU=Radeon RX 6600|Advanced Micro Devices, Inc.';
    assert.deepEqual(parseWindowsGpuProbeOutput(output), [
      { model: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA' },
      { model: 'Intel(R) UHD Graphics 630', vendor: 'Intel Corporation' },
      { model: 'Radeon RX 6600', vendor: 'Advanced Micro Devices, Inc.' },
    ]);
  });

  await test('解析：只有名称或只有厂商的记录保留；名称里带 | 时按最后一个 | 切分', () => {
    assert.deepEqual(
      parseWindowsGpuProbeOutput(
        'GPU=Mystery Adapter|\nGPU=|Some Vendor\nGPU=A|B card|Vendor X',
      ),
      [
        { model: 'Mystery Adapter', vendor: '' },
        { model: '', vendor: 'Some Vendor' },
        { model: 'A|B card', vendor: 'Vendor X' },
      ],
    );
  });

  await test('解析：null 和空输出都是空列表', () => {
    assert.deepEqual(parseWindowsGpuProbeOutput(null), []);
    assert.deepEqual(parseWindowsGpuProbeOutput(''), []);
    assert.deepEqual(parseWindowsGpuProbeOutput('nothing useful'), []);
  });

  await test('probeWindowsGpus：把探测命令和超时交给 run，并解析输出', async () => {
    const seen: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
    const result = await probeWindowsGpus(
      async (file, args, timeoutMs) => {
        seen.push({ file, args, timeoutMs });
        return 'GPU=GeForce GTX 1650|NVIDIA\n';
      },
      'E:\\Windows',
      1234,
    );
    assert.deepEqual(result, [{ model: 'GeForce GTX 1650', vendor: 'NVIDIA' }]);
    assert.equal(seen.length, 1, '只应该起一次 PowerShell');
    assert.equal(seen[0].timeoutMs, 1234);
    assert.ok(seen[0].file.startsWith('E:\\Windows\\System32'));
  });

  await test('probeWindowsGpus：命令没跑成 → 抛错并带上原因，区别于“没有显卡”的 []', async () => {
    await assert.rejects(
      probeWindowsGpus(async () => null),
      /Windows GPU probe failed or timed out/,
    );
    await assert.rejects(
      probeWindowsGpus(async () => {
        throw new Error('timed out after 10000 ms');
      }),
      /Windows GPU probe failed: timed out after 10000 ms/,
    );
    assert.deepEqual(await probeWindowsGpus(async () => ''), []);
  });

  await test('真实子进程：正常输出被解析', async () => {
    const result = await probeWindowsGpus(
      runViaNode(
        `process.stdout.write('GPU=NVIDIA GeForce RTX 4090|NVIDIA\\r\\nGPU=AMD Radeon(TM) Graphics|Advanced Micro Devices, Inc.\\r\\n')`,
      ),
    );
    assert.deepEqual(result, [
      { model: 'NVIDIA GeForce RTX 4090', vendor: 'NVIDIA' },
      {
        model: 'AMD Radeon(TM) Graphics',
        vendor: 'Advanced Micro Devices, Inc.',
      },
    ]);
  });

  await test('真实子进程：stderr 上有噪声（如进度记录）但退出码为 0 → 照常解析 stdout，不因为 stderr 就放弃', async () => {
    // systeminformation 遇到 stderr 上的任何输出都会 kill 子进程，这正是它崩溃的导火索
    const result = await probeWindowsGpus(
      runViaNode(
        `process.stderr.write('#< CLIXML\\n<Objs Version=1.1.0.1></Objs>'); process.stdout.write('GPU=Intel(R) UHD Graphics|Intel Corporation\\r\\n')`,
      ),
    );
    assert.deepEqual(result, [
      { model: 'Intel(R) UHD Graphics', vendor: 'Intel Corporation' },
    ]);
  });

  await test('真实子进程：启动即退出 → 没有显卡 []；写了 stderr 再非零退出 / 直接非零退出 → 抛带原因的错误；全程没有未捕获异常', async () => {
    assert.deepEqual(await probeWindowsGpus(runViaNode('')), []);
    await assert.rejects(
      probeWindowsGpus(
        runViaNode(`process.stderr.write('boom'); process.exit(1)`),
      ),
      /Windows GPU probe failed: exit code 1: boom/,
    );
    await assert.rejects(
      probeWindowsGpus(runViaNode('process.exit(3)')),
      /Windows GPU probe failed: exit code 3/,
    );
    // 给任何迟到的异步 'error' 事件留出浮现的时间
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(uncaught, [], '子进程提前退出不能变成主进程的未捕获异常');
  });

  await test('真实子进程：失败原因取 stderr 的第一行非空内容，并限制长度', async () => {
    await assert.rejects(
      runCommandOrThrow(
        process.execPath,
        [
          '-e',
          `process.stderr.write('\\n  \\n  first line ' + 'x'.repeat(500) + '\\nsecond line'); process.exit(1)`,
        ],
        10_000,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.startsWith('exit code 1: first line xxx'),
          error.message,
        );
        assert.ok(!error.message.includes('second line'), error.message);
        assert.ok(
          error.message.length <= 'exit code 1: '.length + 200,
          `原因应当被限制在 200 个字符内：${error.message.length}`,
        );
        return true;
      },
    );
  });

  await test('真实子进程：命令不存在 → 抛错，说明是起不来', async () => {
    await assert.rejects(
      probeWindowsGpus((_file, _args, timeoutMs) =>
        runCommandOrThrow(
          '/definitely/not/a/real/powershell.exe',
          [],
          timeoutMs,
        ),
      ),
      /Windows GPU probe failed: could not start \(ENOENT\)/,
    );
  });

  await test('真实子进程：卡住不返回 → 超时后抛错，不会一直等', async () => {
    const started = Date.now();
    await assert.rejects(
      probeWindowsGpus((_file, _args) =>
        runCommandOrThrow(
          process.execPath,
          ['-e', 'setTimeout(() => {}, 30000)'],
          300,
        ),
      ),
      /Windows GPU probe failed: timed out after 300 ms/,
    );
    assert.ok(Date.now() - started < 10_000, '应当在超时后很快返回');
  });

  await test('Windows：只走 PowerShell 探测，绝不调用 systeminformation.graphics()', async () => {
    let runs = 0;
    const gpus = await enumerateGenericGpus({
      platform: 'win32',
      siGraphics: NO_SI,
      run: async () => {
        runs++;
        return 'GPU=Radeon RX 6600|Advanced Micro Devices, Inc.\n';
      },
      systemRoot: 'C:\\Windows',
    });
    assert.equal(runs, 1);
    assert.deepEqual(gpus, [
      { model: 'Radeon RX 6600', vendor: 'Advanced Micro Devices, Inc.' },
    ]);
  });

  await test('Windows：探测失败时抛错（交给 detectGpus 现有的降级逻辑），而不是静默返回', async () => {
    await assert.rejects(
      enumerateGenericGpus({
        platform: 'win32',
        siGraphics: NO_SI,
        run: async () => null,
      }),
      /GPU probe/,
    );
  });

  await test('Windows：run 抛出带原因的错误 → 原因保留在错误信息里（detectGpus 会把它写进日志）', async () => {
    await assert.rejects(
      enumerateGenericGpus({
        platform: 'win32',
        siGraphics: NO_SI,
        run: async () => {
          throw new Error('exit code 1: Access is denied');
        },
      }),
      /Windows GPU probe failed: exit code 1: Access is denied/,
    );
  });

  await test('探测预算：要比 10 秒长（windows-latest 真机上，冷启动的 PowerShell 第一次要 10.1 秒）', async () => {
    assert.ok(
      WINDOWS_GPU_PROBE_TIMEOUT_MS > 10_000,
      `预算 ${WINDOWS_GPU_PROBE_TIMEOUT_MS} ms 覆盖不了冷启动的 PowerShell`,
    );
    // 生产入口默认就用这个预算，没有谁悄悄传了更短的
    const budgets: number[] = [];
    await enumerateGenericGpus({
      platform: 'win32',
      siGraphics: NO_SI,
      run: async (_file, _args, timeoutMs) => {
        budgets.push(timeoutMs);
        return '';
      },
    });
    assert.deepEqual(budgets, [WINDOWS_GPU_PROBE_TIMEOUT_MS]);
  });

  await test('Windows：探测成功但没有显卡 → 空列表（不是错误）', async () => {
    assert.deepEqual(
      await enumerateGenericGpus({
        platform: 'win32',
        siGraphics: NO_SI,
        run: async () => '',
      }),
      [],
    );
  });

  for (const platform of ['darwin', 'linux'] as const) {
    await test(`${platform}：沿用 systeminformation.graphics()，过滤掉没有型号也没有厂商的条目`, async () => {
      let runs = 0;
      const gpus = await enumerateGenericGpus({
        platform,
        siGraphics: async () => ({
          controllers: [
            { model: 'Apple M2 Pro', vendor: 'Apple' },
            { model: '', vendor: '' },
            { model: 'Radeon Pro', vendor: undefined },
          ],
        }),
        run: async () => {
          runs++;
          return null;
        },
      });
      assert.equal(runs, 0, `${platform} 不应起 PowerShell`);
      assert.deepEqual(gpus, [
        { model: 'Apple M2 Pro', vendor: 'Apple' },
        { model: 'Radeon Pro', vendor: '' },
      ]);
    });
  }

  await test('非 Windows：graphics() 没有 controllers 字段 → 空列表', async () => {
    assert.deepEqual(
      await enumerateGenericGpus({
        platform: 'linux',
        siGraphics: async () => ({}),
        run: async () => null,
      }),
      [],
    );
  });

  await test('非 Windows：graphics() 超时 → 抛错，且不留下会拖住进程的定时器', async () => {
    const started = Date.now();
    await assert.rejects(
      enumerateGenericGpus({
        platform: 'linux',
        siGraphics: () => new Promise(() => {}),
        run: async () => null,
        timeoutMs: 100,
      }),
      /timeout/i,
    );
    assert.ok(Date.now() - started < 5000);
  });

  await test('非 Windows：graphics() 抛错 → 原样抛出', async () => {
    await assert.rejects(
      enumerateGenericGpus({
        platform: 'linux',
        siGraphics: async () => {
          throw new Error('lspci missing');
        },
        run: async () => null,
      }),
      /lspci missing/,
    );
  });

  process.off('uncaughtException', onUncaught);
  assert.deepEqual(uncaught, [], '整个套件期间不应有未捕获异常');
  finish('GPU 枚举');
}

void main();
