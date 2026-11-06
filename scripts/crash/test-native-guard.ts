import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BreakerEnv } from '../../main/helpers/crash/breaker';
import {
  DISABLE_BREAKER_ENV,
  beginNativeCall,
  lookupSuppression,
  recordNativeSuccess,
  resetSuppressions,
  snapshotBreaker,
} from '../../main/helpers/crash/nativeGuard';
import {
  beginRun,
  getPreviousRunNotice,
  markCleanExit,
  resetRunLifecycleForTests,
  type BeginRunOptions,
} from '../../main/helpers/crash/runLifecycle';
import { readRunState } from '../../main/helpers/crash/runState';
import { buildMinidump } from './minidumpFixture';
import { assert, finish, test } from './testkit';

const ADDON_VULKAN = '/app/addons/addon.vulkan.node';
const ADDON_CPU = '/app/addons/addon.node';

interface Sandbox {
  dir: string;
  options: BeginRunOptions;
  logs: Array<{ message: string; level: string }>;
  clock: { now: number };
  env: {
    cpuModel: string;
    files: Record<string, { size: number; mtimeMs: number }>;
  };
}

function withSandbox<T>(run: (box: Sandbox) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-guard-'));
  resetRunLifecycleForTests();
  const logs: Sandbox['logs'] = [];
  const clock = { now: 1_000_000 };
  const env: Sandbox['env'] = {
    cpuModel: 'Intel Core i7-3770',
    files: {
      [ADDON_VULKAN]: { size: 100, mtimeMs: 5000 },
      [ADDON_CPU]: { size: 200, mtimeMs: 6000 },
    },
  };
  const breakerEnv = (): BreakerEnv => ({
    platform: 'win32',
    arch: 'x64',
    cpuModel: env.cpuModel,
    osRelease: '10.0.22631',
    appVersion: '2.2.0',
    statFile: (p) => env.files[p] ?? null,
  });
  const box: Sandbox = {
    dir,
    logs,
    clock,
    env,
    options: {
      stateFile: path.join(dir, 'crash-state.json'),
      dumpsDir: path.join(dir, 'crash-dumps'),
      eventsFile: path.join(dir, 'logs', 'crash-events.jsonl'),
      appVersion: '2.2.0',
      platform: 'win32',
      arch: 'x64',
      log: (message, level) => logs.push({ message, level: String(level) }),
      now: () => clock.now,
      breakerEnv,
    },
  };
  const saved = process.env[DISABLE_BREAKER_ENV];
  delete process.env[DISABLE_BREAKER_ENV];
  try {
    return run(box);
  } finally {
    if (saved === undefined) delete process.env[DISABLE_BREAKER_ENV];
    else process.env[DISABLE_BREAKER_ENV] = saved;
    resetRunLifecycleForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function dropDump(box: Sandbox, mtimeMs: number, code: number): void {
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

const VULKAN_CALL = {
  engine: 'whisper',
  backend: 'vulkan',
  candidateKey: 'builtin:vulkan',
  candidatePath: ADDON_VULKAN,
  phase: 'transcribe',
};

/** 开始一次原生调用，然后“崩溃”：不调用结束函数，下一次 beginRun 看到的就是遗留的标记。 */
function crashDuring(box: Sandbox, code: number | null) {
  beginRun(box.options);
  beginNativeCall(VULKAN_CALL);
  if (code !== null) dropDump(box, box.clock.now + 500, code);
  box.clock.now += 60_000;
  resetRunLifecycleForTests();
}

async function main() {
  await test('没有绑定（第二个实例、单测）时：不写标记、不抑制、快照为空', () =>
    withSandbox((box) => {
      const end = beginNativeCall(VULKAN_CALL);
      assert.doesNotThrow(() => end());
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.doesNotThrow(() => recordNativeSuccess('builtin:vulkan'));
      assert.equal(resetSuppressions(), 0);
      assert.deepEqual(snapshotBreaker(), {
        enabled: false,
        suppressions: [],
        strikes: [],
      });
      assert.equal(fs.existsSync(box.options.stateFile), false);
    }));

  await test('在途标记同步写入状态文件，结束后移除；重复结束不出错', () =>
    withSandbox((box) => {
      beginRun(box.options);
      const end = beginNativeCall(VULKAN_CALL);
      const during = readRunState(box.options.stateFile);
      assert.equal(during?.inFlight.length, 1);
      assert.equal(during?.inFlight[0].candidateKey, 'builtin:vulkan');
      assert.equal(during?.inFlight[0].engine, 'whisper');
      assert.equal(typeof during?.inFlight[0].startedAt, 'number');

      const second = beginNativeCall({
        ...VULKAN_CALL,
        candidateKey: 'builtin:cpu',
      });
      assert.equal(readRunState(box.options.stateFile)?.inFlight.length, 2);

      end();
      end();
      const after = readRunState(box.options.stateFile);
      assert.deepEqual(
        after?.inFlight.map((m) => m.candidateKey),
        ['builtin:cpu'],
      );
      second();
      assert.deepEqual(readRunState(box.options.stateFile)?.inFlight, []);
    }));

  await test('崩溃 + 新转储：下次启动抑制该候选；提示里说明停用了什么；抑制跨运行保留', () =>
    withSandbox((box) => {
      crashDuring(box, 0xc0000005);

      beginRun(box.options);
      const hit = lookupSuppression('builtin:vulkan');
      assert.equal(hit?.scope, 'candidate');
      assert.equal(hit?.evidence, 'strong');
      assert.equal(lookupSuppression('builtin:cpu'), null);
      assert.deepEqual(getPreviousRunNotice()?.suppressed, [
        { scope: 'candidate', reason: 'crash', key: 'builtin:vulkan' },
      ]);
      assert.ok(
        box.logs.some(
          (l) =>
            l.level === 'warning' &&
            /builtin:vulkan suppressed/.test(l.message),
        ),
      );
      assert.equal(
        readRunState(box.options.stateFile)?.breaker.suppressions.length,
        1,
      );

      // 又一次正常使用后退出，再启动：抑制还在
      markCleanExit();
      box.clock.now += 60_000;
      resetRunLifecycleForTests();
      beginRun(box.options);
      assert.ok(lookupSuppression('builtin:vulkan'));
      assert.equal(getPreviousRunNotice(), null);
    }));

  await test('非法指令：整族被抑制（vulkan、cpu、cuda 都不可用），custom 仍可用', () =>
    withSandbox((box) => {
      crashDuring(box, 0xc000001d);
      beginRun(box.options);
      for (const key of [
        'builtin:vulkan',
        'builtin:cpu',
        'userData:cuda:12.4.0',
      ]) {
        assert.equal(lookupSuppression(key)?.scope, 'family', key);
        assert.equal(lookupSuppression(key)?.reason, 'isa', key);
      }
      assert.equal(lookupSuppression('custom:custom'), null);
      assert.equal(getPreviousRunNotice()?.suppressed?.[0].scope, 'family');
    }));

  await test('弱证据：没有转储时连续 2 次才抑制；中间一次成功就清零', () =>
    withSandbox((box) => {
      crashDuring(box, null);
      beginRun(box.options);
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.equal(snapshotBreaker().strikes[0].count, 1);

      recordNativeSuccess('builtin:vulkan');
      assert.deepEqual(snapshotBreaker().strikes, []);
      assert.equal(
        readRunState(box.options.stateFile)?.breaker.strikes.length,
        0,
      );

      // 清零后再来 2 次才抑制
      beginNativeCall(VULKAN_CALL); // 这一轮崩溃（没有 end）
      box.clock.now += 60_000;
      resetRunLifecycleForTests();
      beginRun(box.options);
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      beginNativeCall(VULKAN_CALL);
      box.clock.now += 60_000;
      resetRunLifecycleForTests();
      beginRun(box.options);
      assert.equal(lookupSuppression('builtin:vulkan')?.evidence, 'weak');
    }));

  await test('正常退出时仍在途的标记不算证据（原生线程只是被正常退出打断）', () =>
    withSandbox((box) => {
      beginRun(box.options);
      beginNativeCall(VULKAN_CALL);
      dropDump(box, box.clock.now + 500, 0xc0000005); // 退出收尾时的转储也不算
      markCleanExit();
      assert.deepEqual(readRunState(box.options.stateFile)?.inFlight, []);

      box.clock.now += 60_000;
      resetRunLifecycleForTests();
      beginRun(box.options);
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.deepEqual(snapshotBreaker().strikes, []);
      assert.equal(getPreviousRunNotice(), null);
    }));

  await test('手动重置：清空抑制与计数并落盘，返回清掉的条数', () =>
    withSandbox((box) => {
      crashDuring(box, 0xc0000005);
      beginRun(box.options);
      assert.ok(lookupSuppression('builtin:vulkan'));

      assert.equal(resetSuppressions(), 1);
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.equal(
        readRunState(box.options.stateFile)?.breaker.suppressions.length,
        0,
      );
      assert.equal(resetSuppressions(), 0);
    }));

  await test('启动时环境变了（换 CPU）：旧的抑制失效并记一行日志', () =>
    withSandbox((box) => {
      crashDuring(box, 0xc0000005);
      beginRun(box.options);
      assert.ok(lookupSuppression('builtin:vulkan'));
      markCleanExit();

      box.env.cpuModel = 'AMD Ryzen 7 5800X';
      box.clock.now += 60_000;
      resetRunLifecycleForTests();
      box.logs.length = 0;
      beginRun(box.options);
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.ok(
        box.logs.some((l) =>
          /cleared because the environment changed/.test(l.message),
        ),
      );
      assert.equal(
        readRunState(box.options.stateFile)?.breaker.suppressions.length,
        0,
      );
    }));

  await test('addon 文件被替换（大小或修改时间变了）：抑制在查询时失效', () =>
    withSandbox((box) => {
      crashDuring(box, 0xc0000005);
      beginRun(box.options);
      assert.ok(lookupSuppression('builtin:vulkan'));
      box.env.files[ADDON_VULKAN] = { size: 101, mtimeMs: 5000 };
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.equal(snapshotBreaker().suppressions.length, 0);
    }));

  await test('显卡指纹：加载时补上并落盘；之后显卡或驱动变了才失效', () =>
    withSandbox((box) => {
      crashDuring(box, 0xc0000005);
      beginRun(box.options);
      assert.equal(
        snapshotBreaker().suppressions[0].fingerprint.gpu,
        undefined,
      );

      assert.ok(lookupSuppression('builtin:vulkan', 'GTX 1060@551.23'));
      assert.equal(
        readRunState(box.options.stateFile)?.breaker.suppressions[0].fingerprint
          .gpu,
        'GTX 1060@551.23',
      );
      assert.ok(lookupSuppression('builtin:vulkan', 'GTX 1060@551.23'));
      assert.equal(
        lookupSuppression('builtin:vulkan', 'GTX 1060@560.94'),
        null,
      );
    }));

  await test('回退开关 SMARTSUB_DISABLE_CRASH_BREAKER=true：不写标记、不对账、不抑制', () =>
    withSandbox((box) => {
      crashDuring(box, 0xc0000005);

      process.env[DISABLE_BREAKER_ENV] = 'true';
      beginRun(box.options);
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.equal(getPreviousRunNotice()?.suppressed, undefined);
      const end = beginNativeCall(VULKAN_CALL);
      assert.deepEqual(readRunState(box.options.stateFile)?.inFlight, []);
      end();
      assert.equal(snapshotBreaker().enabled, false);
    }));

  await test('回退开关只是暂时不用：已有的抑制记录照样保留，关掉开关后重新生效', () =>
    withSandbox((box) => {
      crashDuring(box, 0xc0000005);
      beginRun(box.options);
      assert.ok(lookupSuppression('builtin:vulkan'));
      markCleanExit();

      process.env[DISABLE_BREAKER_ENV] = 'true';
      box.clock.now += 60_000;
      resetRunLifecycleForTests();
      beginRun(box.options);
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.equal(
        readRunState(box.options.stateFile)?.breaker.suppressions.length,
        1,
      );
      markCleanExit();

      delete process.env[DISABLE_BREAKER_ENV];
      box.clock.now += 60_000;
      resetRunLifecycleForTests();
      beginRun(box.options);
      assert.ok(lookupSuppression('builtin:vulkan'));
    }));

  await test('没有提供环境信息时不启用熔断，但上次异常退出的提示照常', () =>
    withSandbox((box) => {
      const options = { ...box.options, breakerEnv: undefined };
      beginRun(options);
      beginNativeCall(VULKAN_CALL); // 未绑定：不会写标记
      dropDump(box, box.clock.now + 500, 0xc0000005);
      box.clock.now += 60_000;
      resetRunLifecycleForTests();
      beginRun(options);
      assert.equal(lookupSuppression('builtin:vulkan'), null);
      assert.deepEqual(getPreviousRunNotice()?.evidence, ['dump']);
      assert.equal(getPreviousRunNotice()?.suppressed, undefined);
    }));

  finish('native-guard');
}

main();
