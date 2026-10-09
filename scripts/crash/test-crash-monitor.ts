import {
  createCrashMonitor,
  formatCrashEventForLog,
  type CrashLogLevel,
  type CrashMonitorOptions,
} from '../../main/helpers/crash/crashMonitor';
import type { CrashEvent } from '../../main/helpers/crash/crashEvents';
import { assert, finish, test } from './testkit';

interface Harness {
  monitor: ReturnType<typeof createCrashMonitor>;
  events: CrashEvent[];
  logs: Array<{ message: string; level: CrashLogLevel }>;
  clock: { now: number };
}

function setup(overrides: Partial<CrashMonitorOptions> = {}): Harness {
  const events: CrashEvent[] = [];
  const logs: Harness['logs'] = [];
  const clock = { now: 1_000_000 };
  const monitor = createCrashMonitor({
    platform: 'win32',
    arch: 'x64',
    appVersion: '3.0.0-test',
    append: (e) => events.push(e),
    snapshotContext: () => [
      {
        engine: 'whisper-builtin',
        backend: 'Vulkan',
        model: 'ggml-base.bin',
        phase: 'transcribe',
        startedAt: 1,
      },
    ],
    redact: (text) => text.replace(/C:\\Users\\Alice/gi, '~'),
    now: () => clock.now,
    ...overrides,
  });
  monitor.setLogSink((message, level) => logs.push({ message, level }));
  return { monitor, events, logs, clock };
}

const ILLEGAL = -1073741795; // 0xC000001D 的有符号形式

async function main() {
  await test('utilityProcess 非法指令：记录分类、现场与版本信息，日志为 error', () => {
    const { monitor, events, logs } = setup();
    // 真实形态：serviceName 是 Chromium 的 Mojo 服务名，我们传给 fork 的名字在 name 里
    const event = monitor.onChildProcessGone({
      type: 'Utility',
      reason: 'crashed',
      exitCode: ILLEGAL,
      serviceName: 'node.mojom.NodeService',
      name: 'sherpa-funasr',
    });
    assert.ok(event);
    assert.equal(events.length, 1);
    assert.equal(event.source, 'child-process-gone');
    assert.equal(event.processType, 'Utility');
    assert.equal(event.name, 'sherpa-funasr');
    assert.equal(event.serviceName, 'node.mojom.NodeService');
    assert.equal(event.classification?.kind, 'illegal-instruction');
    assert.equal(event.classification?.isIsa, true);
    assert.equal(event.exitCode, ILLEGAL);
    assert.equal(event.appVersion, '3.0.0-test');
    assert.equal(event.platform, 'win32');
    assert.deepEqual(event.context?.[0].model, 'ggml-base.bin');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'error');
    assert.ok(logs[0].message.includes('ILLEGAL_INSTRUCTION'));
    // 日志优先显示我们设置的名字，Chromium 的服务名放在括号里
    assert.ok(
      logs[0].message.includes(
        'Utility sherpa-funasr (node.mojom.NodeService)',
      ),
      logs[0].message,
    );
    assert.ok(
      logs[0].message.includes(
        'whisper-builtin/Vulkan/ggml-base.bin/transcribe',
      ),
    );
  });

  await test('干净退出不记录', () => {
    const { monitor, events, logs } = setup();
    assert.equal(
      monitor.onChildProcessGone({
        type: 'Utility',
        reason: 'clean-exit',
        exitCode: 0,
      }),
      null,
    );
    assert.equal(
      monitor.onRenderProcessGone({ reason: 'clean-exit', exitCode: 0 }),
      null,
    );
    assert.equal(events.length + logs.length, 0);
  });

  await test('被外部杀死：记录但只是 warning；非零退出同理', () => {
    const { monitor, events, logs } = setup({ platform: 'linux' });
    monitor.onChildProcessGone({
      type: 'Utility',
      reason: 'killed',
      exitCode: 9,
    });
    monitor.onChildProcessGone({
      type: 'Utility',
      reason: 'abnormal-exit',
      exitCode: 1,
    });
    assert.equal(events.length, 2);
    assert.deepEqual(
      logs.map((l) => l.level),
      ['warning', 'warning'],
    );
    assert.equal(events[0].classification?.isCrash, false);
  });

  await test('应用确认退出之后：不再记“被杀”，但崩溃照记', () => {
    const { monitor, events } = setup({ platform: 'linux' });
    monitor.markShuttingDown();
    assert.equal(
      monitor.onChildProcessGone({
        type: 'Utility',
        reason: 'killed',
        exitCode: 9,
      }),
      null,
    );
    const crashed = monitor.onChildProcessGone({
      type: 'Utility',
      reason: 'crashed',
      exitCode: 11,
    });
    assert.ok(crashed);
    assert.equal(events.length, 1);
    assert.equal(crashed.classification?.signal, 'SIGSEGV');
  });

  await test('渲染进程：崩溃与 OOM 记录为 Renderer；原因与退出码保留', () => {
    const { monitor, events, logs } = setup();
    monitor.onRenderProcessGone({ reason: 'crashed', exitCode: -1073741819 });
    monitor.onRenderProcessGone({ reason: 'oom', exitCode: 0 });
    assert.equal(events.length, 2);
    assert.equal(events[0].processType, 'Renderer');
    assert.equal(events[0].classification?.kind, 'access-violation');
    assert.equal(events[1].classification?.kind, 'oom');
    assert.deepEqual(
      logs.map((l) => l.level),
      ['error', 'error'],
    );
  });

  await test('未启用 crashReporter 的 0xFFFF7003 也会记录，并标明真实码丢失', () => {
    const { monitor, events } = setup();
    monitor.onChildProcessGone({
      type: 'Utility',
      reason: 'crashed',
      exitCode: 0xffff7003,
    });
    assert.equal(events[0].classification?.kind, 'crashpad-lost-code');
    assert.equal(events[0].classification?.realCodeLost, true);
  });

  await test('未捕获异常：消息与栈脱敏、截断；origin 记入 detail', () => {
    const { monitor, events, logs } = setup();
    const error = new Error('cannot open C:\\Users\\Alice\\video.mp4');
    error.stack =
      'Error: cannot open C:\\Users\\Alice\\video.mp4\n' +
      Array.from(
        { length: 20 },
        (_, i) => `    at fn${i} (C:\\Users\\Alice\\app.js:${i}:1)`,
      ).join('\n');
    const event = monitor.onUncaughtException(error, 'uncaughtException');
    assert.ok(event);
    assert.equal(event.source, 'uncaught-exception');
    assert.equal(event.errorName, 'Error');
    assert.ok(event.message?.includes('~\\video.mp4'));
    assert.ok(!event.message?.includes('Alice'));
    assert.ok(!event.stack?.includes('Alice'));
    assert.equal(event.stack?.split('\n').length, 8);
    assert.equal(event.detail, 'uncaughtException');
    assert.equal(logs[0].level, 'error');
    assert.ok(!logs[0].message.includes('Alice'));
  });

  await test('未捕获异常：非 Error 对象、超长消息都能处理', () => {
    const { monitor } = setup();
    const a = monitor.onUncaughtException('plain string', 'unhandledRejection');
    assert.equal(a?.errorName, 'NonErrorThrown');
    assert.equal(a?.message, 'plain string');
    const b = monitor.onUncaughtException(new Error('x'.repeat(5000)));
    assert.ok((b?.message?.length ?? 0) <= 501);
  });

  await test('同一异常在 10 秒内重复抛出只记一次，之后再记；总量有上限', () => {
    const { monitor, events, clock } = setup();
    const make = () => new Error('same failure');
    assert.ok(monitor.onUncaughtException(make()));
    clock.now += 5_000;
    assert.equal(monitor.onUncaughtException(make()), null);
    clock.now += 6_000;
    assert.ok(monitor.onUncaughtException(make()));
    assert.equal(events.length, 2);

    // 不同的异常最多记 50 条
    for (let i = 0; i < 100; i++)
      monitor.onUncaughtException(new Error(`distinct ${i}`));
    assert.equal(
      events.filter((e) => e.source === 'uncaught-exception').length,
      50,
    );
  });

  await test('单次运行最多 200 条事件，防止异常循环写爆磁盘', () => {
    const { monitor, events } = setup();
    for (let i = 0; i < 300; i++) {
      monitor.onChildProcessGone({
        type: 'Utility',
        reason: 'crashed',
        exitCode: ILLEGAL,
      });
    }
    assert.equal(events.length, 200);
  });

  await test('日志通道接入之前的日志先缓存，接入时按序补发；缓存有上限', () => {
    const logs: Array<{ message: string; level: CrashLogLevel }> = [];
    const monitor = createCrashMonitor({
      platform: 'win32',
      arch: 'x64',
      appVersion: 'x',
      append: () => undefined,
      snapshotContext: () => [],
    });
    for (let i = 0; i < 60; i++) {
      monitor.onChildProcessGone({
        type: 'GPU',
        reason: 'crashed',
        exitCode: 0xc0000005 | 0,
        name: `p${i}`,
      });
    }
    monitor.setLogSink((message, level) => logs.push({ message, level }));
    assert.equal(logs.length, 50);
    assert.ok(logs[0].message.includes('p10'));
    assert.ok(logs[49].message.includes('p59'));
    // 接入之后直接输出
    monitor.onChildProcessGone({
      type: 'GPU',
      reason: 'crashed',
      exitCode: 0xc0000005 | 0,
      name: 'late',
    });
    assert.ok(logs[50].message.includes('late'));
  });

  await test('监视器自身出错不会抛出：落盘失败、现场快照失败、日志失败都被吞掉', () => {
    const monitor = createCrashMonitor({
      platform: 'win32',
      arch: 'x64',
      appVersion: 'x',
      append: () => {
        throw new Error('disk full');
      },
      snapshotContext: () => {
        throw new Error('no context');
      },
    });
    monitor.setLogSink(() => {
      throw new Error('log failed');
    });
    const event = monitor.onChildProcessGone({
      type: 'Utility',
      reason: 'crashed',
      exitCode: ILLEGAL,
    });
    assert.ok(event);
    assert.equal(event.context, undefined);
    assert.doesNotThrow(() => monitor.onUncaughtException(new Error('x')));
    assert.doesNotThrow(() =>
      monitor.onRenderProcessGone({ reason: 'crashed', exitCode: 1 }),
    );
  });

  await test('日志文本是单行且不含花括号（日志脱敏器会把花括号当 JSON 处理）', () => {
    const { monitor, events } = setup();
    monitor.onChildProcessGone({
      type: 'Utility',
      reason: 'crashed',
      exitCode: ILLEGAL,
      serviceName: 's',
    });
    monitor.onUncaughtException(new Error('a {b} c'), 'uncaughtException');
    for (const event of events) {
      const line = formatCrashEventForLog(event);
      assert.ok(!line.includes('\n'));
      if (event.source === 'child-process-gone') {
        assert.ok(!/[{}]/.test(line), line);
      }
    }
  });

  finish('crashMonitor');
}

main();
