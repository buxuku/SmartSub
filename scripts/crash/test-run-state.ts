import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RUN_STATE_VERSION,
  createRunStateStore,
  parseRunState,
  readRunState,
  writeRunStateSync,
  type RunState,
} from '../../main/helpers/crash/runState';
import { assert, finish, test } from './testkit';

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-run-state-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE: RunState = {
  version: RUN_STATE_VERSION,
  cleanExit: false,
  startedAt: 1000,
  appVersion: '2.0.0',
  inFlight: [
    {
      callId: 'a',
      engine: 'whisper-builtin',
      backend: 'vulkan',
      model: 'ggml-base.bin',
      phase: 'transcribe',
      candidatePath: '/x/addon.vulkan.node',
      startedAt: 1500,
    },
  ],
};

async function main() {
  await test('写入再读取往返一致；写入不留下临时文件', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-state.json');
      assert.equal(writeRunStateSync(file, SAMPLE), true);
      assert.deepEqual(readRunState(file), SAMPLE);
      assert.deepEqual(fs.readdirSync(dir), ['crash-state.json']);
    }));

  await test('读取宽容：文件不存在、乱码、版本不符、缺字段都返回 null', () => {
    assert.equal(readRunState('/nonexistent/crash-state.json'), null);
    assert.equal(parseRunState(''), null);
    assert.equal(parseRunState('{not json'), null);
    assert.equal(parseRunState('[]'), null);
    assert.equal(parseRunState('null'), null);
    assert.equal(
      parseRunState(JSON.stringify({ ...SAMPLE, version: 99 })),
      null,
    );
    assert.equal(
      parseRunState(JSON.stringify({ ...SAMPLE, cleanExit: 'yes' })),
      null,
    );
    assert.equal(
      parseRunState(JSON.stringify({ ...SAMPLE, startedAt: '1000' })),
      null,
    );
  });

  await test('在途标记里不合格的条目被丢弃，合格的保留；inFlight 缺失按空处理', () => {
    const parsed = parseRunState(
      JSON.stringify({
        ...SAMPLE,
        inFlight: [
          SAMPLE.inFlight[0],
          { callId: 1, engine: 'x', startedAt: 1 },
          { callId: 'b', startedAt: 1 },
          { callId: 'c', engine: 'x' },
          'oops',
          null,
          { callId: 'd', engine: 'sherpa-tts', startedAt: 2, backend: 3 },
        ],
      }),
    );
    assert.deepEqual(
      parsed?.inFlight.map((m) => m.callId),
      ['a', 'd'],
    );
    // 类型不对的可选字段被忽略，而不是整条丢弃
    assert.equal(parsed?.inFlight[1].backend, undefined);

    const noList = parseRunState(
      JSON.stringify({
        version: RUN_STATE_VERSION,
        cleanExit: true,
        startedAt: 5,
      }),
    );
    assert.deepEqual(noList?.inFlight, []);
  });

  await test('生命周期：启动写 cleanExit=false，正常退出写 true，下次启动读到上次的状态', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-state.json');
      let now = 1000;

      const first = createRunStateStore(file, () => now);
      assert.equal(first.previous, null);
      first.markStarted('1.0.0');
      let onDisk = readRunState(file);
      assert.equal(onDisk?.cleanExit, false);
      assert.equal(onDisk?.startedAt, 1000);
      assert.equal(onDisk?.appVersion, '1.0.0');

      now = 5000;
      first.markCleanExit();
      onDisk = readRunState(file);
      assert.equal(onDisk?.cleanExit, true);
      assert.equal(onDisk?.endedAt, 5000);
      assert.equal(onDisk?.startedAt, 1000);

      now = 9000;
      const second = createRunStateStore(file, () => now);
      assert.equal(second.previous?.cleanExit, true);
      second.markStarted('1.0.1');
      // 新一次运行把状态重置为“未正常退出”，并且不继承上次的在途标记
      assert.equal(readRunState(file)?.cleanExit, false);
      assert.equal(readRunState(file)?.startedAt, 9000);
      assert.deepEqual(readRunState(file)?.inFlight, []);
      // 内存里保留的“上一次”不受影响
      assert.equal(second.previous?.cleanExit, true);
    }));

  await test('崩溃（没走到 markCleanExit）后，下次启动读到 cleanExit=false 与遗留的在途标记', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-state.json');
      const run = createRunStateStore(file, () => 2000);
      run.markStarted();
      run.update((state) => {
        state.inFlight.push(SAMPLE.inFlight[0]);
      });
      // —— 进程在这里崩溃，没有任何收尾 ——
      const next = createRunStateStore(file, () => 8000);
      assert.equal(next.previous?.cleanExit, false);
      assert.equal(next.previous?.startedAt, 2000);
      assert.equal(next.previous?.inFlight.length, 1);
      assert.equal(next.previous?.inFlight[0].engine, 'whisper-builtin');
    }));

  await test('current() 返回副本：改它不会影响内部状态', () =>
    withTempDir((dir) => {
      const run = createRunStateStore(path.join(dir, 's.json'), () => 1);
      run.markStarted();
      const copy = run.current();
      copy.inFlight.push(SAMPLE.inFlight[0]);
      copy.cleanExit = true;
      assert.deepEqual(run.current().inFlight, []);
      assert.equal(run.current().cleanExit, false);
    }));

  await test('写入失败不抛错，只返回 false（目录位置被一个普通文件占住）', () =>
    withTempDir((dir) => {
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'x');
      const file = path.join(blocker, 'crash-state.json');
      const origError = console.error;
      console.error = () => {};
      try {
        assert.equal(writeRunStateSync(file, SAMPLE), false);
        const run = createRunStateStore(file, () => 1);
        assert.doesNotThrow(() => {
          run.markStarted();
          run.markCleanExit();
          run.update(() => {});
        });
      } finally {
        console.error = origError;
      }
    }));

  finish('run-state');
}

main();
