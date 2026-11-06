import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  KEEP_SYSTEM_CORE_ENV,
  describeCoreDumpShrink,
  shrinkOwnCoreDump,
  writeCoreDumpFilter,
} from '../../main/helpers/crash/coreDump';
import { assert, finish, test } from './testkit';

/** 记录写入调用的假 writeFile；fail 给出时每次调用都抛它。 */
function fakeWriter(fail?: unknown) {
  const calls: Array<{ file: string; data: string }> = [];
  return {
    calls,
    writeFile: (file: string, data: string) => {
      calls.push({ file, data });
      if (fail !== undefined) throw fail;
    },
  };
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function main() {
  await test('Linux 且没关开关：本进程 coredump_filter 写 0（只写一次），返回 applied', () => {
    const w = fakeWriter();
    const result = shrinkOwnCoreDump({
      platform: 'linux',
      env: {},
      writeFile: w.writeFile,
    });
    assert.deepEqual(result, { status: 'applied' });
    assert.deepEqual(w.calls, [
      { file: '/proc/self/coredump_filter', data: '0' },
    ]);
  });

  await test('Windows 与 macOS：什么都不做', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const w = fakeWriter();
      const result = shrinkOwnCoreDump({
        platform,
        env: {},
        writeFile: w.writeFile,
      });
      assert.deepEqual(result, { status: 'skipped', reason: 'not-linux' });
      assert.equal(w.calls.length, 0);
    }
  });

  await test(`${KEEP_SYSTEM_CORE_ENV}=true 保留系统默认：不写；其它取值不算关闭`, () => {
    const off = fakeWriter();
    assert.deepEqual(
      shrinkOwnCoreDump({
        platform: 'linux',
        env: { [KEEP_SYSTEM_CORE_ENV]: 'true' },
        writeFile: off.writeFile,
      }),
      { status: 'skipped', reason: 'kept-by-env' },
    );
    assert.equal(off.calls.length, 0);

    // 与仓库里其它开关一致，只认精确的 'true'
    for (const value of ['false', '1', '', 'TRUE', undefined]) {
      const w = fakeWriter();
      const result = shrinkOwnCoreDump({
        platform: 'linux',
        env: { [KEEP_SYSTEM_CORE_ENV]: value },
        writeFile: w.writeFile,
      });
      assert.deepEqual(result, { status: 'applied' }, String(value));
      assert.equal(w.calls.length, 1, String(value));
    }
  });

  await test('写失败：不抛错，返回 failed 与原因（errno 代码优先，其次消息首行）', () => {
    const cases: Array<[unknown, string]> = [
      [errnoError('EACCES', 'EACCES: permission denied, open ...'), 'EACCES'],
      [errnoError('EROFS', 'read-only file system'), 'EROFS'],
      [new Error('第一行\n第二行'), '第一行'],
      [new Error(''), 'write failed'],
      ['plain string', 'plain string'],
      [undefined, 'write failed'],
      [null, 'write failed'],
    ];
    for (const [thrown, expected] of cases) {
      // fakeWriter 里 fail === undefined 表示“不抛”，所以这里用显式的抛出函数
      const result = shrinkOwnCoreDump({
        platform: 'linux',
        env: {},
        writeFile: () => {
          throw thrown;
        },
      });
      assert.deepEqual(
        result,
        { status: 'failed', reason: expected },
        String(thrown),
      );
    }
  });

  await test('writeCoreDumpFilter：路径由 pid 或 self 拼出，写入内容恒为 0；成功返回 null，失败返回原因', () => {
    const w = fakeWriter();
    assert.equal(writeCoreDumpFilter(4242, w.writeFile), null);
    assert.equal(writeCoreDumpFilter('self', w.writeFile), null);
    assert.deepEqual(w.calls, [
      { file: '/proc/4242/coredump_filter', data: '0' },
      { file: '/proc/self/coredump_filter', data: '0' },
    ]);

    const failing = fakeWriter(errnoError('ESRCH', 'no such process'));
    assert.equal(writeCoreDumpFilter(4242, failing.writeFile), 'ESRCH');
  });

  await test('writeCoreDumpFilter 默认实现：目标不存在时返回原因文本而不是抛错', () => {
    // 进程不存在（或根本没有 /proc）：各平台都应得到一个非空的原因
    const reason = writeCoreDumpFilter(0x7fffffff);
    assert.equal(typeof reason, 'string');
    assert.ok(reason && reason.length > 0);
  });

  await test('启动日志：applied 与 kept-by-env 是 info，failed 是 warning 且带原因，非 Linux 没有日志', () => {
    const applied = describeCoreDumpShrink({ status: 'applied' });
    assert.equal(applied?.level, 'info');
    assert.ok(applied?.message.includes('coredump_filter'));

    const kept = describeCoreDumpShrink({
      status: 'skipped',
      reason: 'kept-by-env',
    });
    assert.equal(kept?.level, 'info');
    assert.ok(kept?.message.includes(KEEP_SYSTEM_CORE_ENV));

    const failed = describeCoreDumpShrink({
      status: 'failed',
      reason: 'EACCES',
    });
    assert.equal(failed?.level, 'warning');
    assert.ok(failed?.message.includes('EACCES'));

    assert.equal(
      describeCoreDumpShrink({ status: 'skipped', reason: 'not-linux' }),
      null,
    );
  });

  if (process.platform === 'linux') {
    const filterOf = (target: number | 'self') =>
      parseInt(
        fs.readFileSync(`/proc/${target}/coredump_filter`, 'utf8').trim(),
        16,
      );
    const spawnIdleChild = async () => {
      const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
      ]);
      await new Promise((resolve) => child.once('spawn', resolve));
      return child;
    };

    await test('Linux 真机：writeCoreDumpFilter 把另一个进程的 coredump_filter 写成 0', async () => {
      const child = await spawnIdleChild();
      try {
        assert.equal(writeCoreDumpFilter(child.pid as number), null);
        assert.equal(filterOf(child.pid as number), 0);
      } finally {
        child.kill();
      }
    });

    await test('Linux 真机：本进程写过之后，之后启动的子进程继承 coredump_filter=0', async () => {
      const original = fs
        .readFileSync('/proc/self/coredump_filter', 'utf8')
        .trim();
      const result = shrinkOwnCoreDump({ env: {} });
      if (result.status !== 'applied') {
        // 个别受限环境不让写 /proc/self：逻辑已由上面的假实现覆盖，烟测在真 Electron 里再验一次
        console.log(
          `  （本机不让写 /proc/self/coredump_filter，跳过：${JSON.stringify(result)}）`,
        );
        return;
      }
      let child: Awaited<ReturnType<typeof spawnIdleChild>> | null = null;
      try {
        assert.equal(filterOf('self'), 0);
        child = await spawnIdleChild();
        assert.equal(filterOf(child.pid as number), 0, '子进程应继承 0');
      } finally {
        child?.kill();
        // 还原，避免影响同一进程里之后的任何东西
        fs.writeFileSync('/proc/self/coredump_filter', original);
      }
    });
  }

  finish('core-dump');
}

void main();
