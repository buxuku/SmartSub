import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { UtilityHost } from '../../main/helpers/crash/utilityHost';
import { runWhisperProbe } from '../../main/helpers/crash/whisperProbe';
import { assert, finish, test } from './testkit';

class Child extends EventEmitter {
  stderr = new PassThrough();
  sent: any[] = [];
  kills = 0;
  postMessage(message: any) {
    this.sent.push(message);
  }
  kill() {
    this.kills++;
    this.emit('exit', 15);
    return true;
  }
}

function setup(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const child = new Child();
  const crashes: unknown[] = [];
  const promise = runWhisperProbe({
    request: { model: 'large-v3-turbo', backend: 'vulkan', vad: true },
    addonPath: '/private/addon.node',
    addonSource: 'builtin',
    params: { pcmf32: new Float32Array([0.1]) },
    clean: (text) => text.replaceAll('/private', '~'),
    ...options,
    spawn: (onStderrLine) =>
      new UtilityHost({
        workerFile: '/worker.cjs',
        serviceName: 'probe',
        logLabel: 'probe',
        env: {},
        log: () => {},
        onStderrLine,
        recordExit: (record) => crashes.push(record),
        deps: { platform: 'win32', fork: () => child as any },
      }),
  });
  return { child, crashes, promise };
}

async function main() {
  await test('crash after successful dlopen preserves device enumeration, stderr and exit classification', async () => {
    const { child, promise, crashes } = setup();
    assert.equal(child.sent[0].type, 'run');
    assert.ok(child.sent[0].params.pcmf32 instanceof Float32Array);
    child.emit('message', { type: 'phase', phase: 'transcribe' });
    child.stderr.write('ggml_vulkan: 0 = AMD Radeon(TM) 780M\n');
    child.stderr.write('whisper_backend_init_gpu: using Vulkan0 backend\n');
    child.stderr.write('progress\n'.repeat(4000));
    child.stderr.write('failure in /private/model'); // no newline, flush on exit
    child.emit('exit', -1073741819); // 0xc0000005
    const result = await promise;
    assert.equal(result.status, 'exited');
    assert.equal(result.phase, 'transcribe');
    assert.equal(result.exit?.kind, 'access-violation');
    assert.equal(result.nativeDeviceLines.length, 2);
    assert.ok(result.stderrTail.endsWith('failure in ~/model\n'));
    assert.ok(result.stderrTail.length <= 16 * 1024);
    assert.equal(result.addonPath, '~/addon.node');
    assert.equal(crashes.length, 1);
  });
  await test('success waits for a clean shutdown and records only segment count', async () => {
    const { child, promise } = setup();
    child.emit('message', {
      type: 'result',
      ok: true,
      segments: 3,
      transcription: ['private text'],
    });
    assert.deepEqual(child.sent[1], { type: 'shutdown' });
    child.stderr.write('native cleanup complete\n');
    child.emit('exit', 0);
    const result = await promise;
    assert.equal(result.status, 'completed');
    assert.equal(result.segments, 3);
    assert.match(result.stderrTail, /cleanup complete/);
    assert.ok(!JSON.stringify(result).includes('private text'));
  });
  await test('zero exit without a result and crashes during teardown are failures', async () => {
    for (const code of [0, -1073741819]) {
      const { child, promise } = setup();
      if (code)
        child.emit('message', { type: 'result', ok: true, segments: 1 });
      child.emit('exit', code);
      assert.equal((await promise).status, 'exited');
    }
  });
  await test('ordinary addon errors are retained separately from native crashes', async () => {
    const { child, promise } = setup();
    child.emit('message', {
      type: 'result',
      ok: false,
      error: 'cannot load /private/model',
    });
    child.emit('exit', 0);
    const result = await promise;
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'cannot load ~/model');
    assert.equal(result.exit?.kind, 'clean');
  });
  await test('cancellation and timeout terminate the disposable process without crash records', async () => {
    const controller = new AbortController();
    const cancelled = setup({ signal: controller.signal });
    controller.abort();
    assert.equal((await cancelled.promise).status, 'cancelled');
    assert.equal(cancelled.child.kills, 1);
    assert.equal(cancelled.crashes.length, 0);
    const timed = setup({ timeoutMs: 5 });
    assert.equal((await timed.promise).status, 'timeout');
    assert.equal(timed.child.kills, 1);
    assert.equal(timed.crashes.length, 0);
  });
  await test('already cancelled requests do not spawn or load native code', async () => {
    const controller = new AbortController();
    controller.abort();
    const { child, promise } = setup({ signal: controller.signal });
    assert.equal((await promise).status, 'cancelled');
    assert.equal(child.sent.length, 0);
  });
  await test('real worker protocol catches loader errors and does not send transcripts', async () => {
    const {
      runProbe,
    } = require('../../extraResources/diagnostics/whisper-probe.cjs');
    const messages: any[] = [];
    await runProbe(
      { addonPath: 'bad', params: {} },
      (m: any) => messages.push(m),
      () => {
        throw new Error('missing DLL');
      },
    );
    assert.deepEqual(messages.at(-1), {
      type: 'result',
      ok: false,
      error: 'missing DLL',
    });
    messages.length = 0;
    await runProbe(
      { addonPath: 'ok', params: {} },
      (m: any) => messages.push(m),
      () => (_params: any, done: any) =>
        done(null, { transcription: [[0, 1, 'text']] }),
    );
    assert.deepEqual(messages.at(-1), {
      type: 'result',
      ok: true,
      segments: 1,
    });
  });
  finish('Whisper diagnostic');
}
void main();
