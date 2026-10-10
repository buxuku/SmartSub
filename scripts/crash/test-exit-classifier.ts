import {
  classifyExit,
  describeExit,
  formatNtStatus,
} from '../../main/helpers/crash/exitClassifier';
import { assert, finish, test } from './testkit';

// 退出码样本来自 PoC 在 windows-latest / ubuntu-24.04 / macOS arm64 上的实测，
// 以及 Electron 在 Windows 上上报 NTSTATUS 的两种形式：child-process-gone 是有符号 32 位整数，
// utilityProcess 的 exit 事件是符号扩展后再变成 double 的 64 位数（低位已丢，见下方用例）。

async function main() {
  await test('Windows：NTSTATUS 的有符号与无符号写法等价', () => {
    assert.equal(formatNtStatus(-1073741795), '0xC000001D');
    assert.equal(formatNtStatus(0xc000001d), '0xC000001D');
    for (const exitCode of [-1073741795, 0xc000001d]) {
      const c = classifyExit({
        platform: 'win32',
        exitCode,
        reason: 'crashed',
      });
      assert.equal(c.kind, 'illegal-instruction');
      assert.equal(c.isIsa, true);
      assert.equal(c.isCrash, true);
      assert.equal(c.code, '0xC000001D');
      assert.equal(c.label, 'ILLEGAL_INSTRUCTION');
    }
  });

  await test('Windows：访问违例、快速失败、栈溢出、堆损坏各自归类，且不是指令集问题', () => {
    const cases: [number, string][] = [
      [-1073741819, 'access-violation'],
      [-1073740791, 'fast-fail'],
      [-1073741571, 'stack-overflow'],
      [-1073740940, 'heap-corruption'],
    ];
    for (const [exitCode, kind] of cases) {
      const c = classifyExit({
        platform: 'win32',
        exitCode,
        reason: 'crashed',
      });
      assert.equal(c.kind, kind, `exitCode ${exitCode}`);
      assert.equal(c.isIsa, false);
      assert.equal(c.isCrash, true);
    }
  });

  await test('Windows：未启用 crashReporter 时的 0xFFFF7003 标记为真实码丢失，不当作指令集', () => {
    // 0xFFFF7003 = 4294930435，按有符号 32 位上报时是 -36861
    assert.equal((-36861 >>> 0).toString(16), 'ffff7003');
    for (const exitCode of [0xffff7003, -36861]) {
      const c = classifyExit({
        platform: 'win32',
        exitCode,
        reason: 'crashed',
      });
      assert.equal(c.kind, 'crashpad-lost-code');
      assert.equal(c.realCodeLost, true);
      assert.equal(c.isCrash, true);
      assert.equal(c.isIsa, false);
    }
  });

  await test('Windows：utilityProcess exit 事件的崩溃码低位已丢（2^64 - 2^30）：认出是崩溃，但不冒充具体异常', () => {
    // windows-latest + Electron 30.5.1 实测：非法指令与访问违例都是这一个数
    const measured = 18446744072635810000;
    assert.equal(measured, 2 ** 64 - 2 ** 30);
    for (const exitCode of [
      measured,
      2 ** 64 - 2048,
      2 ** 64 - 2 ** 30 + 2 ** 20,
    ]) {
      const c = classifyExit({ platform: 'win32', exitCode });
      assert.equal(c.kind, 'crash-unknown', `exitCode ${exitCode}`);
      assert.equal(c.isCrash, true);
      assert.equal(c.abnormal, true);
      assert.equal(c.isIsa, false, '低位已丢，不能当作指令集问题');
      assert.equal(c.realCodeLost, true);
      assert.equal(c.label, 'NTSTATUS_ERROR');
      assert.equal(c.code, '~0xC0000000');
    }
    assert.equal(
      describeExit(classifyExit({ platform: 'win32', exitCode: measured })),
      'crash-unknown (NTSTATUS_ERROR ~0xC0000000)',
    );

    // 不是 0xC0000000 及以上的错误级别，或根本不在 2^64 附近：照旧按非零退出处理
    for (const exitCode of [
      2 ** 64 - 2 ** 31, // 对应 0x80000000，警告级别
      2 ** 64 - 2 ** 30 - 4096, // 对应 0xBFFFF000，不是错误级别
      2 ** 64, // 恰好 2^64
      4294967296 + 5, // 刚过 32 位的垃圾值
      1e10,
    ]) {
      const c = classifyExit({ platform: 'win32', exitCode });
      assert.equal(c.kind, 'exit-nonzero', `exitCode ${exitCode}`);
      assert.equal(c.isCrash, false);
    }
    // 精确的 32 位写法不受影响
    assert.equal(
      classifyExit({ platform: 'win32', exitCode: -1073741795 }).kind,
      'illegal-instruction',
    );
  });

  await test('Windows：Node 的 process.abort 实现为 _exit(134)，按 abort 归类', () => {
    const c = classifyExit({ platform: 'win32', exitCode: 134 });
    assert.equal(c.kind, 'abort');
    assert.equal(c.label, 'NODE_ABORT');
  });

  await test('Windows：正常退出、非零退出、OOM、外部终止', () => {
    assert.equal(
      classifyExit({ platform: 'win32', exitCode: 0, reason: 'clean-exit' })
        .kind,
      'clean',
    );
    const nonzero = classifyExit({
      platform: 'win32',
      exitCode: 1,
      reason: 'abnormal-exit',
    });
    assert.equal(nonzero.kind, 'exit-nonzero');
    assert.equal(nonzero.isCrash, false);
    assert.equal(nonzero.abnormal, true);
    assert.equal(
      classifyExit({ platform: 'win32', reason: 'oom' }).kind,
      'oom',
    );
    const killed = classifyExit({
      platform: 'win32',
      exitCode: 0xc000013a,
      reason: 'killed',
    });
    assert.equal(killed.kind, 'killed');
    assert.equal(killed.isCrash, false);
  });

  await test('自己 kill 的进程不分类，无论退出码是什么（macOS 父进程 kill 后退出码是垃圾值）', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const c = classifyExit({ platform, exitCode: 4, killedByUs: true });
      assert.equal(c.kind, 'killed-by-us');
      assert.equal(c.isCrash, false);
      assert.equal(c.abnormal, false);
    }
  });

  await test('Linux：裸信号编号', () => {
    const cases: [number, string, string][] = [
      [4, 'illegal-instruction', 'SIGILL'],
      [11, 'access-violation', 'SIGSEGV'],
      [7, 'access-violation', 'SIGBUS'],
      [6, 'abort', 'SIGABRT'],
      [8, 'arithmetic', 'SIGFPE'],
    ];
    for (const [exitCode, kind, signal] of cases) {
      const c = classifyExit({
        platform: 'linux',
        exitCode,
        reason: 'crashed',
      });
      assert.equal(c.kind, kind, signal);
      assert.equal(c.signal, signal);
      assert.equal(c.isCrash, true);
      assert.equal(c.isIsa, signal === 'SIGILL');
      assert.equal(c.core, undefined);
    }
  });

  await test('Linux：产生 core dump 时是原始 wait status（bit7），要解码出信号', () => {
    const abrt = classifyExit({
      platform: 'linux',
      exitCode: 134,
      reason: 'crashed',
    });
    assert.equal(abrt.signal, 'SIGABRT');
    assert.equal(abrt.core, true);
    const segv = classifyExit({
      platform: 'linux',
      exitCode: 139,
      reason: 'crashed',
    });
    assert.equal(segv.signal, 'SIGSEGV');
    assert.equal(segv.core, true);
    const ill = classifyExit({
      platform: 'linux',
      exitCode: 132,
      reason: 'crashed',
    });
    assert.equal(ill.signal, 'SIGILL');
    assert.equal(ill.isIsa, true);
  });

  await test('POSIX：被杀死不算崩溃；非零退出码不会被误判成信号', () => {
    const killed = classifyExit({
      platform: 'linux',
      exitCode: 9,
      reason: 'killed',
    });
    assert.equal(killed.kind, 'killed');
    assert.equal(killed.isCrash, false);
    // Chromium 的 abnormal-exit 是进程自己以非零码退出，不是被信号杀死
    const exited = classifyExit({
      platform: 'linux',
      exitCode: 4,
      reason: 'abnormal-exit',
    });
    assert.equal(exited.kind, 'exit-nonzero');
    assert.equal(exited.isCrash, false);
    assert.equal(
      classifyExit({ platform: 'darwin', exitCode: 0, reason: 'clean-exit' })
        .kind,
      'clean',
    );
  });

  await test('POSIX：没拿到 gone 事件（没有 reason）时退回信号表', () => {
    const ill = classifyExit({ platform: 'linux', exitCode: 4 });
    assert.equal(ill.kind, 'illegal-instruction');
    assert.equal(ill.isIsa, true);
    const term = classifyExit({ platform: 'linux', exitCode: 15 });
    assert.equal(term.kind, 'killed');
    assert.equal(term.isCrash, false);
    const kill = classifyExit({ platform: 'linux', exitCode: 9 });
    assert.equal(kill.kind, 'killed'); // SIGKILL
    // 1 与 2 同时是 SIGHUP / SIGINT 的编号和最常见的退出码（process.exit(1)），无 reason 时无法区分，
    // 按普通非零退出处理，不能误判成“被杀”
    for (const exitCode of [1, 2, 42]) {
      const c = classifyExit({ platform: 'linux', exitCode });
      assert.equal(c.kind, 'exit-nonzero', `exitCode ${exitCode}`);
      assert.equal(c.isCrash, false);
      assert.equal(c.abnormal, true);
    }
    // 明确带 reason: killed 时仍按信号解码标签
    assert.equal(
      classifyExit({ platform: 'linux', exitCode: 1, reason: 'killed' }).label,
      'SIGHUP',
    );
  });

  await test('Linux 与 macOS 的 7 / 10 号信号含义不同', () => {
    assert.equal(
      classifyExit({ platform: 'linux', exitCode: 7, reason: 'crashed' })
        .signal,
      'SIGBUS',
    );
    assert.equal(
      classifyExit({ platform: 'darwin', exitCode: 7, reason: 'crashed' })
        .signal,
      'SIGEMT',
    );
    assert.equal(
      classifyExit({ platform: 'darwin', exitCode: 10, reason: 'crashed' })
        .signal,
      'SIGBUS',
    );
    assert.equal(
      classifyExit({ platform: 'darwin', exitCode: 4, reason: 'crashed' })
        .isIsa,
      true,
    );
  });

  await test('OOM、启动失败、完整性失败', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      assert.equal(classifyExit({ platform, reason: 'oom' }).kind, 'oom');
      assert.equal(
        classifyExit({ platform, reason: 'launch-failed' }).kind,
        'launch-failed',
      );
      assert.equal(
        classifyExit({ platform, reason: 'integrity-failure' }).kind,
        'integrity-failure',
      );
    }
  });

  await test('describeExit 的可读描述', () => {
    assert.equal(
      describeExit(
        classifyExit({
          platform: 'win32',
          exitCode: -1073741795,
          reason: 'crashed',
        }),
      ),
      'illegal-instruction (ILLEGAL_INSTRUCTION 0xC000001D)',
    );
    assert.equal(
      describeExit(
        classifyExit({ platform: 'linux', exitCode: 134, reason: 'crashed' }),
      ),
      'abort (SIGABRT core-dumped)',
    );
  });

  finish('exitClassifier');
}

main();
