import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginRun,
  dismissPreviousRunNotice,
  getPreviousRunAssessment,
  getPreviousRunNotice,
  getRunStateStore,
  markCleanExit,
  resetRunLifecycleForTests,
  type BeginRunOptions,
} from '../../main/helpers/crash/runLifecycle';
import { readCrashEvents } from '../../main/helpers/crash/crashEvents';
import { readRunState } from '../../main/helpers/crash/runState';
import { buildMinidump } from './minidumpFixture';
import { assert, finish, test } from './testkit';

interface Sandbox {
  dir: string;
  options: BeginRunOptions;
  logs: Array<{ message: string; level: string }>;
  clock: { now: number };
}

function withSandbox<T>(run: (box: Sandbox) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-run-life-'));
  resetRunLifecycleForTests();
  const logs: Sandbox['logs'] = [];
  const clock = { now: 1_000_000 };
  const box: Sandbox = {
    dir,
    logs,
    clock,
    options: {
      stateFile: path.join(dir, 'crash-state.json'),
      dumpsDir: path.join(dir, 'crash-dumps'),
      eventsFile: path.join(dir, 'logs', 'crash-events.jsonl'),
      appVersion: '2.2.0',
      platform: 'win32',
      arch: 'x64',
      log: (message, level) => logs.push({ message, level: String(level) }),
      now: () => clock.now,
    },
  };
  try {
    return run(box);
  } finally {
    resetRunLifecycleForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 在转储目录里放一份真实结构的最小 minidump，并把 mtime 定在指定时间。 */
function dropDump(box: Sandbox, mtimeMs: number, code = 0xc000001d): void {
  const file = path.join(box.options.dumpsDir, 'reports', `${mtimeMs}.dmp`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    buildMinidump({
      os: 'windows',
      cpu: { family: 6, model: 58, stepping: 9 },
      modules: [
        { name: 'C:\\app\\addon.vulkan.node', base: 0x1000n, size: 0x1000 },
      ],
      exception: { code, address: 0x1800n },
    }),
  );
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

async function main() {
  await test('首次启动：没有上次的记录，不提示；状态文件写成 cleanExit=false', () =>
    withSandbox((box) => {
      const assessment = beginRun(box.options);
      assert.equal(assessment?.status, 'unknown');
      assert.equal(getPreviousRunNotice(), null);
      assert.deepEqual(box.logs, []);
      assert.equal(readRunState(box.options.stateFile)?.cleanExit, false);
      assert.equal(readRunState(box.options.stateFile)?.appVersion, '2.2.0');
    }));

  await test('正常退出再启动：不提示、不写日志、没有 previous-run 事件', () =>
    withSandbox((box) => {
      beginRun(box.options);
      markCleanExit();
      assert.equal(readRunState(box.options.stateFile)?.cleanExit, true);

      box.clock.now += 60_000;
      const assessment = beginRun(box.options);
      assert.equal(assessment?.status, 'clean');
      assert.equal(getPreviousRunNotice(), null);
      assert.deepEqual(box.logs, []);
      assert.deepEqual(readCrashEvents(box.options.eventsFile), []);
    }));

  await test('崩溃后再启动：有新转储才提示，并写一条 previous-run 事件；提示一次性', () =>
    withSandbox((box) => {
      beginRun(box.options); // 上次运行：startedAt = 1_000_000，之后崩溃，没有 markCleanExit
      dropDump(box, 1_000_000 + 30_000);

      box.clock.now += 120_000;
      const assessment = beginRun(box.options);
      assert.equal(assessment?.status, 'abnormal');
      const notice = getPreviousRunNotice();
      assert.equal(notice?.kind, 'illegal-instruction');
      assert.equal(notice?.faultModule, 'addon.vulkan.node');
      assert.deepEqual(notice?.evidence, ['dump']);
      assert.equal(box.logs.length, 1);
      assert.equal(box.logs[0].level, 'warning');

      const events = readCrashEvents(box.options.eventsFile);
      assert.equal(events.length, 1);
      assert.equal(events[0].source, 'previous-run');
      assert.equal(events[0].classification?.isIsa, true);

      // 提示被确认后不再给；再下一次启动时这份转储已经早于“上次启动”，也不会重复
      dismissPreviousRunNotice();
      assert.equal(getPreviousRunNotice(), null);
      box.logs.length = 0;
      box.clock.now += 120_000;
      resetRunLifecycleForTests();
      beginRun(box.options);
      assert.equal(getPreviousRunNotice(), null);
      assert.equal(readCrashEvents(box.options.eventsFile).length, 1);
    }));

  await test('异常结束但没有证据：只有一行 info 日志，没有提示、没有事件', () =>
    withSandbox((box) => {
      beginRun(box.options);
      box.clock.now += 60_000;
      const assessment = beginRun(box.options);
      assert.equal(assessment?.status, 'abnormal');
      assert.equal(getPreviousRunNotice(), null);
      assert.equal(box.logs.length, 1);
      assert.equal(box.logs[0].level, 'info');
      assert.deepEqual(readCrashEvents(box.options.eventsFile), []);
    }));

  await test('在途标记作证据：崩溃时标记还在文件里，下次启动提示并带出引擎', () =>
    withSandbox((box) => {
      beginRun(box.options);
      getRunStateStore()?.update((state) => {
        state.inFlight.push({
          callId: 'x',
          engine: 'whisper-builtin',
          backend: 'cuda 12.4.0',
          startedAt: box.clock.now + 5,
        });
      });
      box.clock.now += 60_000;
      beginRun(box.options);
      const notice = getPreviousRunNotice();
      assert.deepEqual(notice?.evidence, ['in-flight']);
      assert.equal(notice?.engine, 'whisper-builtin');
      assert.equal(notice?.backend, 'cuda 12.4.0');
      // 新一次运行不继承旧标记
      assert.deepEqual(readRunState(box.options.stateFile)?.inFlight, []);
      assert.equal(getPreviousRunAssessment()?.inFlight.length, 1);
    }));

  await test('更早的崩溃留下的转储不会被当成这次的证据', () =>
    withSandbox((box) => {
      dropDump(box, 500_000); // 比下面“上次启动”早得多
      beginRun(box.options);
      box.clock.now += 60_000;
      beginRun(box.options);
      assert.equal(getPreviousRunNotice(), null);
    }));

  await test('第二个实例或没启动过时调用 markCleanExit 不抛错、不创建文件', () =>
    withSandbox((box) => {
      assert.doesNotThrow(() => markCleanExit());
      assert.equal(fs.existsSync(box.options.stateFile), false);
    }));

  await test('路径不可用时 beginRun 也不抛错，应用照常启动', () =>
    withSandbox((box) => {
      const blocker = path.join(box.dir, 'blocker');
      fs.writeFileSync(blocker, 'x');
      const origError = console.error;
      console.error = () => {};
      try {
        assert.doesNotThrow(() =>
          beginRun({
            ...box.options,
            stateFile: path.join(blocker, 'crash-state.json'),
            dumpsDir: path.join(blocker, 'dumps'),
            eventsFile: path.join(blocker, 'events.jsonl'),
          }),
        );
        assert.equal(getPreviousRunNotice(), null);
      } finally {
        console.error = origError;
      }
    }));

  finish('run-lifecycle');
}

main();
