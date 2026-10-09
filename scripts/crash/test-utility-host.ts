import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import {
  UtilityHost,
  buildSherpaWorkerEnv,
  describeHostExit,
  resetUtilityHostStateForTest,
  shrinkCoreDumpViaProc,
  type HostExitInfo,
  type HostLogLevel,
  type SpawnHostOptions,
  type UtilityExitRecord,
} from '../../main/helpers/crash/utilityHost';
import { assert, finish, test } from './testkit';

/** 假的 utilityProcess：只实现底座用到的部分。 */
class FakeProc extends EventEmitter {
  pid: number | undefined = 4242;
  stderr = new PassThrough();
  posted: unknown[] = [];
  killCalls = 0;
  throwOnKill = false;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  kill() {
    this.killCalls++;
    if (this.throwOnKill) throw new Error('already dead');
    return true;
  }
}

interface Harness {
  host: UtilityHost;
  proc: FakeProc;
  logs: Array<{ message: string; level: HostLogLevel }>;
  records: UtilityExitRecord[];
  kills: string[];
  limitCalls: number[];
  /** 对 coredump_filter 与 prlimit 的调用顺序，如 ['filter:4242', 'limit:4242'] */
  coreSteps: string[];
  forkArgs: { file: string; args: string[]; options: any } | null;
  exits: HostExitInfo[];
  order: string[];
}

/**
 * filterResult：coredump_filter 那一步的结果，null 成功、字符串是失败原因、Error 表示直接抛出。
 */
function setup(
  overrides: Partial<SpawnHostOptions> = {},
  platform: NodeJS.Platform = 'linux',
  limitResult: string | null = null,
  filterResult: string | null | Error = null,
): Harness {
  const proc = new FakeProc();
  const logs: Harness['logs'] = [];
  const records: UtilityExitRecord[] = [];
  const kills: string[] = [];
  const limitCalls: number[] = [];
  const coreSteps: string[] = [];
  const exits: HostExitInfo[] = [];
  const order: string[] = [];
  const harness = { forkArgs: null } as Harness;
  const host = new UtilityHost({
    workerFile: '/app/worker.js',
    serviceName: 'smartsub-test-worker',
    logLabel: 'test worker',
    env: { A: '1' },
    log: (message, level) => logs.push({ message, level }),
    recordExit: (record) => {
      order.push('record');
      records.push(record);
    },
    expectKill: (name) => kills.push(name),
    deps: {
      fork: (file, args, options) => {
        harness.forkArgs = { file, args, options };
        return proc as any;
      },
      platform,
      shrinkCoreDump: (pid) => {
        coreSteps.push(`filter:${pid}`);
        if (filterResult instanceof Error) throw filterResult;
        return filterResult;
      },
      limitCore: async (pid) => {
        coreSteps.push(`limit:${pid}`);
        limitCalls.push(pid);
        return limitResult;
      },
    },
    ...overrides,
  });
  host.onExit((info) => {
    order.push('listener');
    exits.push(info);
  });
  return Object.assign(harness, {
    host,
    proc,
    logs,
    records,
    kills,
    limitCalls,
    coreSteps,
    exits,
    order,
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  await test('sherpa worker 环境：原生库目录进入 PATH 与 LD_LIBRARY_PATH，其余保持', () => {
    const env = buildSherpaWorkerEnv(
      '/lib/sherpa',
      { PATH: '/usr/bin', LD_LIBRARY_PATH: '/old', KEEP: 'x' },
      ':',
    );
    assert.equal(env.SHERPA_ONNX_LIB_DIR, '/lib/sherpa');
    assert.equal(env.PATH, '/lib/sherpa:/usr/bin');
    assert.equal(env.LD_LIBRARY_PATH, '/lib/sherpa:/old');
    assert.equal(env.KEEP, 'x');
    // 原先三处的写法在变量缺失时得到“目录 + 分隔符 + 空串”
    const bare = buildSherpaWorkerEnv('C:\\sherpa', {}, ';');
    assert.equal(bare.PATH, 'C:\\sherpa;');
    assert.equal(bare.LD_LIBRARY_PATH, 'C:\\sherpa;');
  });

  await test('fork 参数：serviceName、stdio 为 pipe、环境与脚本路径原样传入', () => {
    const h = setup();
    assert.equal(h.forkArgs?.file, '/app/worker.js');
    assert.deepEqual(h.forkArgs?.args, []);
    assert.equal(h.forkArgs?.options.serviceName, 'smartsub-test-worker');
    assert.equal(h.forkArgs?.options.stdio, 'pipe');
    assert.deepEqual(h.forkArgs?.options.env, { A: '1' });
  });

  await test('stderr：逐块写 warning 日志（沿用原文案），空白块不记', async () => {
    const h = setup();
    h.proc.stderr.write('onnxruntime: bad model\n');
    h.proc.stderr.write('   \n');
    await tick();
    assert.deepEqual(h.logs, [
      {
        message: 'test worker stderr: onnxruntime: bad model',
        level: 'warning',
      },
    ]);
  });

  await test('异常退出：先落盘（含 stderr 尾部与分类）再通知宿主', async () => {
    const h = setup();
    h.proc.stderr.write('last words before crash');
    await tick();
    h.proc.emit('exit', 11); // Linux：退出码即信号号，11 = SIGSEGV
    assert.deepEqual(h.order, ['record', 'listener']);
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].name, 'smartsub-test-worker');
    assert.equal(h.records[0].exitCode, 11);
    assert.equal(h.records[0].classification.kind, 'access-violation');
    assert.ok(h.records[0].stderrTail?.includes('last words before crash'));
    assert.equal(h.exits[0].code, 11);
    assert.equal(h.exits[0].killedByUs, false);
    assert.equal(h.exits[0].classification.isCrash, true);
    assert.equal(
      describeHostExit(h.exits[0]),
      'access-violation (SIGSEGV), code 11',
    );
  });

  await test('非法指令（Windows NTSTATUS）被识别为指令集问题', () => {
    const h = setup({}, 'win32');
    h.proc.emit('exit', -1073741795);
    assert.equal(h.exits[0].classification.isIsa, true);
    assert.equal(h.records[0].classification.kind, 'illegal-instruction');
  });

  await test('正常退出不记录，但仍通知宿主', () => {
    const h = setup();
    h.proc.emit('exit', 0);
    assert.equal(h.records.length, 0);
    assert.equal(h.exits.length, 1);
    assert.equal(h.exits[0].classification.kind, 'clean');
  });

  await test('非零退出（非崩溃）会记录，分类为 exit-nonzero', () => {
    const h = setup();
    h.proc.emit('exit', 1);
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].classification.kind, 'exit-nonzero');
    assert.equal(h.records[0].classification.isCrash, false);
  });

  await test('主动终止：先登记再 kill；随后的垃圾退出码不被当成故障，也不落盘', () => {
    const h = setup();
    h.host.kill();
    assert.deepEqual(h.kills, ['smartsub-test-worker']);
    assert.equal(h.proc.killCalls, 1);
    h.proc.emit('exit', 0x6b0e7680); // 信号终止时的垃圾值（见各宿主原注释）
    assert.equal(h.exits[0].killedByUs, true);
    assert.equal(h.exits[0].classification.kind, 'killed-by-us');
    assert.equal(h.records.length, 0);
  });

  await test('kill 时进程已退出（proc.kill 抛错）不会传播', () => {
    const h = setup();
    h.proc.throwOnKill = true;
    assert.doesNotThrow(() => h.host.kill());
    assert.deepEqual(h.kills, ['smartsub-test-worker']);
  });

  await test('落盘或登记失败都不影响宿主自己的退出处理', () => {
    const h = setup({
      recordExit: () => {
        throw new Error('disk full');
      },
      expectKill: () => {
        throw new Error('monitor gone');
      },
    });
    assert.doesNotThrow(() => h.host.kill());
    h.proc.emit('exit', 11);
    assert.equal(h.exits.length, 1);
  });

  await test('消息原样透传：postMessage 与 onMessage', () => {
    const h = setup();
    const received: unknown[] = [];
    h.host.onMessage((m) => received.push(m));
    h.proc.emit('message', { type: 'ready' });
    h.host.postMessage({ type: 'load' });
    assert.deepEqual(received, [{ type: 'ready' }]);
    assert.deepEqual(h.proc.posted, [{ type: 'load' }]);
  });

  await test('Linux：spawn 后对子进程缩小 core（先同步写 coredump_filter，再 prlimit）；其它平台与没有 pid 时不做', async () => {
    const linux = setup({}, 'linux');
    linux.proc.emit('spawn');
    // 同步那一步在 spawn 事件处理里就做完，不等任何异步；prlimit 紧随其后发起
    assert.deepEqual(linux.coreSteps, ['filter:4242', 'limit:4242']);
    await tick();
    assert.deepEqual(linux.limitCalls, [4242]);

    for (const platform of ['win32', 'darwin'] as const) {
      const other = setup({}, platform);
      other.proc.emit('spawn');
      await tick();
      assert.deepEqual(other.coreSteps, []);
    }

    const noPid = setup({}, 'linux');
    noPid.proc.pid = undefined;
    noPid.proc.emit('spawn');
    await tick();
    assert.deepEqual(noPid.coreSteps, []);
  });

  await test('默认实现：写不了时返回原因文本而不是抛错', () => {
    // 进程不存在（或根本没有 /proc）：各平台都应得到一个非空的原因
    const reason = shrinkCoreDumpViaProc(0x7fffffff);
    assert.equal(typeof reason, 'string');
    assert.ok(reason && reason.length > 0);
  });

  if (process.platform === 'linux') {
    await test('默认实现（Linux 真机）：子进程的 coredump_filter 被写成 0', async () => {
      const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
      ]);
      try {
        await new Promise((resolve) => child.once('spawn', resolve));
        assert.equal(shrinkCoreDumpViaProc(child.pid as number), null);
        const value = fs
          .readFileSync(`/proc/${child.pid}/coredump_filter`, 'utf8')
          .trim();
        assert.equal(parseInt(value, 16), 0, value);
      } finally {
        child.kill();
      }
    });
  }

  await test('coredump_filter 那一步抛错：不传播，prlimit 照常发起', async () => {
    resetUtilityHostStateForTest();
    const h = setup({}, 'linux', null, new Error('EPERM: denied'));
    assert.doesNotThrow(() => h.proc.emit('spawn'));
    await tick();
    assert.deepEqual(h.coreSteps, ['filter:4242', 'limit:4242']);
    // prlimit 成功，所以不提示
    assert.equal(h.logs.length, 0);
  });

  await test('只坏了一层（没有 prlimit 或写不了 coredump_filter）：另一层生效就不提示', async () => {
    resetUtilityHostStateForTest();
    const noPrlimit = setup({}, 'linux', 'spawn prlimit ENOENT', null);
    noPrlimit.proc.emit('spawn');
    await tick();
    assert.equal(noPrlimit.logs.length, 0);

    const noFilter = setup({}, 'linux', null, 'EACCES');
    noFilter.proc.emit('spawn');
    await tick();
    assert.equal(noFilter.logs.length, 0);
  });

  await test('两层都不可用：整个应用运行期只提示一次（带两个原因），且不影响后续流程', async () => {
    resetUtilityHostStateForTest();
    const first = setup({}, 'linux', 'spawn prlimit ENOENT', 'EACCES');
    first.proc.emit('spawn');
    await tick();
    const warnings = first.logs.filter((l) =>
      l.message.includes('RLIMIT_CORE'),
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warning');
    assert.ok(warnings[0].message.includes('ENOENT'));
    assert.ok(warnings[0].message.includes('EACCES'));

    const second = setup({}, 'linux', 'spawn prlimit ENOENT', 'EACCES');
    second.proc.emit('spawn');
    await tick();
    assert.equal(
      second.logs.filter((l) => l.message.includes('RLIMIT_CORE')).length,
      0,
    );
    // 提示过之后宿主仍照常工作
    second.proc.emit('exit', 11);
    assert.equal(second.exits.length, 1);

    // 两层都成功时不提示
    resetUtilityHostStateForTest();
    const ok = setup({}, 'linux', null, null);
    ok.proc.emit('spawn');
    await tick();
    assert.equal(ok.logs.length, 0);
  });

  finish('utilityHost');
}

main();
