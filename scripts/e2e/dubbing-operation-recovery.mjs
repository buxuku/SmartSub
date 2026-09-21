import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-operation-recovery-e2e-'),
);
const profile = path.join(output, 'profile');
const subtitle = path.join(output, 'recovery.srt');
const source = '1\n00:00:00,000 --> 00:00:05,000\nRecovered operation.\n';
await fs.writeFile(subtitle, source);
const wavPath = path.join(output, 'fixture.wav');
execFileSync(ffmpeg, [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000:duration=1',
  '-c:a',
  'pcm_s16le',
  wavPath,
]);
const wav = await fs.readFile(wavPath);
let requests = 0,
  hold = false;
const server = http.createServer(async (request, response) => {
  for await (const chunk of request) {
  }
  requests++;
  if (hold) return;
  response.writeHead(200, { 'Content-Type': 'audio/wav' });
  response.end(wav);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const config = {
  engine: { kind: 'cloud', providerId: 'recovery' },
  voice: 'voice',
  language: 'en',
  globalSpeed: 1,
  background: 'mute',
  output: 'audioOnly',
  audioFormat: 'wav',
  overflow: 'truncate',
  overlapMode: 'mix',
  exportShiftedSubtitle: true,
};
let app, page, root, session, lease, locked;
const errors = [],
  checks = [];
const launch = async () => {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${profile}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await expect
    .poll(() =>
      app.evaluate(({ ipcMain }) =>
        ipcMain._invokeHandlers.has('dubbing:operationStatus'),
      ),
    )
    .toBe(true);
  root = await app.evaluate(({ app, BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    return app.getPath('userData');
  });
};
const invoke = (channel, payload) =>
  page.evaluate(({ channel, payload }) => window.ipc.invoke(channel, payload), {
    channel,
    payload,
  });
const directory = () => path.join(root, 'dubbing-sessions', session.sessionId);
const receiptPath = (id) =>
  path.join(
    directory(),
    '.operations',
    createHash('sha256').update(id).digest('hex') + '.json',
  );
const meta = async () =>
  JSON.parse(await fs.readFile(path.join(directory(), 'session.json'), 'utf8'));
const acquire = async () => {
  lease = `lease-${Date.now()}`;
  const result = await invoke('dubbing:loadSubtitle', {
    sessionId: session.sessionId,
    leaseId: lease,
  });
  assert.equal(result.success, true, result.error);
  return result.data;
};
const kill = async () => {
  const exited = once(app.process(), 'exit');
  app.process().kill('SIGKILL');
  await exited;
  app = undefined;
};
try {
  await launch();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(async (url) => {
    window.ipc.send('setTtsProviders', [
      {
        id: 'recovery',
        name: 'Recovery voice',
        type: 'openaiCompatible',
        apiKey: 'fixture',
        apiUrl: url,
        model: 'fixture',
        voices: 'voice',
      },
    ]);
    await window.ipc.invoke('getTtsProviders');
  }, `http://127.0.0.1:${server.address().port}/v1`);
  lease = 'initial';
  session = (
    await invoke('dubbing:loadSubtitle', {
      subtitlePath: subtitle,
      leaseId: lease,
    })
  ).data;
  assert.ok(session?.sessionId);
  const savedConfig = await invoke('dubbing:syncVoiceState', {
    sessionId: session.sessionId,
    leaseId: lease,
    config,
  });
  assert.equal(savedConfig.success, true, savedConfig.error);
  const payload = (requestId) => ({
    sessionId: session.sessionId,
    leaseId: lease,
    requestId,
    config,
  });
  assert.equal(
    (await invoke('dubbing:start', payload('first-batch'))).success,
    true,
  );
  assert.equal(requests, 1);
  const saved = (await meta()).cues[0].wavFile;
  const savedBytes = await fs.readFile(path.join(directory(), saved));

  locked = path.join(directory(), '.operations');
  await fs.chmod(locked, 0o500);
  const denied = await invoke('dubbing:start', {
    ...payload('denied'),
    force: true,
  });
  assert.equal(denied.success, false);
  assert.match(denied.error, /EACCES|EPERM/);
  assert.equal(requests, 1);
  await fs.chmod(locked, 0o700);
  locked = undefined;
  checks.push(
    'Actual operation receipt chmod failure blocks synthesis before any HTTP request',
  );

  hold = true;
  void invoke('dubbing:resynthesizeCue', {
    ...payload('interrupted-cue'),
    index: 0,
  }).catch(() => {});
  await expect.poll(() => requests).toBe(2);
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(receiptPath('interrupted-cue'), 'utf8'))
          .status,
    )
    .toBe('pending');
  const orphan = 'cue-0-123-12345678-role.wav';
  await fs.writeFile(
    path.join(directory(), orphan),
    'unfinished internal audio',
  );
  await fs.mkdir(path.join(directory(), 'dub-track-Abc123'));
  await fs.writeFile(
    path.join(directory(), 'dub-track-Abc123', 'dub-track.wav'),
    'unfinished track',
  );
  await fs.writeFile(
    path.join(directory(), 'user-audio.wav'),
    'unknown file retained',
  );
  await kill();
  server.closeAllConnections();
  hold = false;
  await launch();
  let restored = await acquire();
  assert.equal(restored.operationRecovery.status, 'interrupted');
  assert.equal(
    (
      await invoke('dubbing:operationStatus', {
        sessionId: session.sessionId,
        leaseId: lease,
        requestId: 'interrupted-cue',
      })
    ).data.status,
    'interrupted',
  );
  const repeated = await invoke('dubbing:resynthesizeCue', {
    ...payload('interrupted-cue'),
    index: 0,
  });
  assert.equal(repeated.success, false);
  assert.match(repeated.error, /interrupted/);
  assert.equal(requests, 2);
  assert.deepEqual(
    await fs.readFile(path.join(directory(), saved)),
    savedBytes,
  );
  await assert.rejects(fs.access(path.join(directory(), orphan)), {
    code: 'ENOENT',
  });
  await assert.rejects(fs.access(path.join(directory(), 'dub-track-Abc123')), {
    code: 'ENOENT',
  });
  assert.equal(
    await fs.readFile(path.join(directory(), 'user-audio.wav'), 'utf8'),
    'unknown file retained',
  );
  await invoke('dubbing:disposeSession', {
    sessionId: session.sessionId,
    leaseId: lease,
  });
  await page.evaluate(
    (id) => window.next.router.push(`/zh/dubbing/?session=${id}`),
    session.sessionId,
  );
  await expect(
    page.getByRole('alert').filter({ hasText: '上次配音操作在确认完成前中断' }),
  ).toBeVisible();
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: path.join(output, `interrupted-${width}.png`),
    });
  }
  checks.push(
    'SIGKILL during real HTTP synthesis restores old audio, marks receipt interrupted, refuses replay, cleans only known unreferenced internal files; visible 1024/1440 warning',
  );
  await page.evaluate(() => window.next.router.push('/zh/home/'));
  await acquire();
  assert.equal(
    (
      await invoke('dubbing:resynthesizeCue', {
        ...payload('explicit-retry'),
        index: 0,
      })
    ).success,
    true,
  );
  assert.equal(requests, 3);

  await invoke('dubbing:disposeSession', {
    sessionId: session.sessionId,
    leaseId: lease,
  });
  await page.evaluate(
    (id) => window.next.router.push(`/zh/dubbing/?session=${id}`),
    session.sessionId,
  );
  await expect(
    page.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  locked = path.join(directory(), '.operations');
  await app.evaluate(({}, directory) => {
    const fs = process.getBuiltinModule('fs');
    const rename = fs.renameSync;
    globalThis.restoreReceiptWrites = () => {
      fs.renameSync = rename;
    };
    fs.renameSync = (...args) => {
      if (
        String(args[1]).startsWith(directory + '/') &&
        String(args[1]).endsWith('.json')
      ) {
        const receipt = JSON.parse(fs.readFileSync(args[0], 'utf8'));
        if (receipt.status === 'complete') fs.chmodSync(directory, 0o500);
      }
      return rename(...args);
    };
  }, locked);
  await page.getByRole('button', { name: '重新合成该行', exact: true }).click();
  await expect.poll(() => requests).toBe(4);
  await expect(
    page.getByRole('alert').filter({ hasText: '恢复记录未能保存' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '导出', exact: true }),
  ).toBeEnabled();
  assert.equal((await meta()).cues[0].status, 'done');
  await app.evaluate(() => globalThis.restoreReceiptWrites());
  await fs.chmod(locked, 0o700);
  locked = undefined;
  await page.evaluate(() => window.next.router.push('/zh/home/'));
  const repaired = await acquire();
  assert.equal(repaired.operationRecovery.status, 'complete');
  assert.equal(repaired.operationRecovery.persistenceError, undefined);
  checks.push(
    'Actual chmod failure after successful synthesis keeps completed audio and visible receipt warning; repaired permissions allow receipt retry on reopening',
  );

  const committedCue = (await meta()).cues[0];
  const committedAudio = await fs.readFile(
    path.join(directory(), committedCue.wavFile),
  );
  await app.evaluate(({}, directory) => {
    const fs = process.getBuiltinModule('fs');
    const path = process.getBuiltinModule('path');
    const rename = fs.renameSync;
    fs.renameSync = (...args) => {
      if (String(args[1]) === path.join(directory, 'session.json')) {
        const previous = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        const next = JSON.parse(fs.readFileSync(args[0], 'utf8'));
        if (
          next.cues[0].wavFile &&
          next.cues[0].wavFile !== previous.cues[0].wavFile
        )
          process.kill(process.pid, 'SIGKILL');
      }
      return rename(...args);
    };
  }, directory());
  const beforeCueCommit = once(app.process(), 'exit');
  void invoke('dubbing:resynthesizeCue', {
    ...payload('cue-before-commit'),
    index: 0,
  }).catch(() => {});
  await beforeCueCommit;
  app = undefined;
  assert.equal(requests, 5);
  const beforeCleanup = await fs.readdir(directory());
  const uncommitted = beforeCleanup.filter(
    (file) => /^cue-.*\.wav$/.test(file) && file !== committedCue.wavFile,
  );
  assert.ok(uncommitted.length > 0);
  await launch();
  await acquire();
  assert.equal((await meta()).cues[0].wavFile, committedCue.wavFile);
  assert.deepEqual(
    await fs.readFile(path.join(directory(), committedCue.wavFile)),
    committedAudio,
  );
  for (const file of uncommitted)
    await assert.rejects(fs.access(path.join(directory(), file)), {
      code: 'ENOENT',
    });
  checks.push(
    'SIGKILL after real TTS WAV generation but before session metadata rename preserves the prior committed audio and removes the actual uncommitted attempt on startup',
  );

  for (const phase of [
    'rendering',
    'first-file',
    'last-file',
    'copy-partial',
    'copy-complete',
  ]) {
    const requestId = `publication-${phase}`;
    const beforeFiles = (await fs.readdir(output))
      .filter((name) => /^recovery-dubbed.*\.(wav|srt)$/.test(name))
      .sort();
    await app.evaluate(({}, phase) => {
      const fs = process.getBuiltinModule('fs');
      if (phase === 'rendering') {
        const copy = fs.promises.copyFile;
        fs.promises.copyFile = async (...args) => {
          const result = await copy(...args);
          if (String(args[1]).includes('.smartsub-compose-'))
            process.kill(process.pid, 'SIGKILL');
          return result;
        };
      } else if (phase.startsWith('copy-')) {
        fs.linkSync = () => {
          throw Object.assign(new Error('fixture unsupported links'), {
            code: 'ENOTSUP',
          });
        };
        if (phase === 'copy-partial') {
          const createWriteStream = fs.createWriteStream;
          fs.createWriteStream = (...args) => {
            const stream = createWriteStream(...args);
            if (String(args[0]).endsWith('.wav')) {
              const write = stream._write;
              stream._write = function (chunk, encoding, callback) {
                write.call(this, chunk.subarray(0, 512), encoding, (error) => {
                  if (!error) process.kill(process.pid, 'SIGKILL');
                  callback(error);
                });
              };
            }
            return stream;
          };
        } else {
          const rename = fs.renameSync;
          fs.renameSync = (...args) => {
            const result = rename(...args);
            if (
              String(args[1]).includes('/.operations/') &&
              String(args[1]).endsWith('.json')
            ) {
              const receipt = JSON.parse(fs.readFileSync(args[1], 'utf8'));
              if (
                receipt.publication?.files.length === 2 &&
                receipt.publication.files.every((file) => file.complete)
              )
                process.kill(process.pid, 'SIGKILL');
            }
            return result;
          };
        }
      } else {
        const link = fs.linkSync;
        fs.linkSync = (...args) => {
          const result = link(...args);
          if (
            String(args[1]).endsWith(
              phase === 'first-file' ? '.wav' : '.dubbed.srt',
            )
          )
            process.kill(process.pid, 'SIGKILL');
          return result;
        };
      }
    }, phase);
    const exited = once(app.process(), 'exit');
    void invoke('dubbing:export', payload(requestId)).catch(() => {});
    await exited;
    app = undefined;
    const beforeRecovery = JSON.parse(
      await fs.readFile(receiptPath(requestId), 'utf8'),
    );
    assert.equal(beforeRecovery.status, 'pending');
    const stagedDirectory = beforeRecovery.publication.directory;
    await fs.access(stagedDirectory);
    await launch();
    const restored = await acquire();
    const status = (
      await invoke('dubbing:operationStatus', {
        sessionId: session.sessionId,
        leaseId: lease,
        requestId,
      })
    ).data;
    if (phase === 'last-file' || phase === 'copy-complete') {
      assert.equal(status.status, 'complete');
      assert.equal(
        restored.operationRecovery.result.data.outputPath,
        status.result.data.outputPath,
      );
      execFileSync(ffmpeg, [
        '-v',
        'error',
        '-i',
        status.result.data.outputPath,
        '-f',
        'null',
        '-',
      ]);
      await fs.access(status.result.data.shiftedSubtitlePath);
      const replayed = await invoke('dubbing:export', payload(requestId));
      assert.equal(replayed.data.outputPath, status.result.data.outputPath);
    } else {
      assert.equal(status.status, 'interrupted');
      assert.deepEqual(
        (await fs.readdir(output))
          .filter((name) => /^recovery-dubbed.*\.(wav|srt)$/.test(name))
          .sort(),
        beforeFiles,
      );
    }
    await assert.rejects(fs.access(stagedDirectory), { code: 'ENOENT' });
    assert.equal(requests, 5);
  }
  checks.push(
    'SIGKILL during private render, after first link and during actual exclusive copy rolls back owned partial outputs; final-link and completed-copy crashes recover paired output before final receipt, with no duplicate export and private directories removed',
  );

  // Kill after the completed export receipt is durable, before its IPC reply returns.
  await app.evaluate(({}, requestId) => {
    const fs = process.getBuiltinModule('fs');
    const rename = fs.renameSync;
    fs.renameSync = (...args) => {
      const result = rename(...args);
      if (
        String(args[1]).includes('/.operations/') &&
        String(args[1]).endsWith('.json')
      ) {
        const receipt = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        if (receipt.requestId === requestId && receipt.status === 'complete')
          process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
  }, 'export-crash');
  const exited = once(app.process(), 'exit');
  void invoke('dubbing:export', payload('export-crash')).catch(() => {});
  await exited;
  app = undefined;
  const exportReceipt = JSON.parse(
    await fs.readFile(receiptPath('export-crash'), 'utf8'),
  );
  assert.equal(exportReceipt.status, 'complete');
  const exported = exportReceipt.result.data.outputPath;
  execFileSync(ffmpeg, ['-v', 'error', '-i', exported, '-f', 'null', '-']);
  await launch();
  restored = await acquire();
  assert.equal(restored.operationRecovery.result.data.outputPath, exported);
  const recoveredTask = await invoke('getWorkItem', session.workItemId);
  assert.equal(recoveredTask.status, 'done');
  assert.ok(
    recoveredTask.artifacts.some((artifact) => artifact.path === exported),
  );
  const replay = await invoke('dubbing:export', payload('export-crash'));
  assert.equal(replay.success, true);
  assert.equal(replay.data.outputPath, exported);
  assert.equal(
    (await fs.readdir(output)).filter((name) =>
      /^recovery-dubbed.*\.wav$/.test(name),
    ).length,
    3,
  );
  assert.equal(requests, 5);
  await invoke('dubbing:disposeSession', {
    sessionId: session.sessionId,
    leaseId: lease,
  });
  await page.evaluate(
    (id) => window.next.router.push(`/zh/dubbing/?session=${id}`),
    session.sessionId,
  );
  await expect(page.getByText(exported, { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'recovered-export.png') });
  assert.equal(await fs.readFile(subtitle, 'utf8'), source);
  checks.push(
    'SIGKILL after durable completed export but before acknowledgement restores exact output/banner; replay creates no extra file or TTS request, WAV decodes and source subtitle remains unchanged',
  );
  await kill();
  const corruptedPath = receiptPath('export-crash');
  const originalReceipt = await fs.readFile(corruptedPath);
  await fs.writeFile(corruptedPath, '{unreadable receipt');
  await launch();
  const rejected = await invoke('dubbing:loadSubtitle', {
    sessionId: session.sessionId,
    leaseId: 'corrupt',
  });
  assert.equal(rejected.success, false);
  assert.equal(await fs.readFile(corruptedPath, 'utf8'), '{unreadable receipt');
  assert.equal(requests, 5);
  await fs.writeFile(corruptedPath, originalReceipt);
  assert.equal(
    (await acquire()).operationRecovery.result.data.outputPath,
    exported,
  );
  checks.push(
    'Corrupt receipt blocks project acquisition without overwriting evidence; repairing exact bytes allows recovery with no synthesis',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ output, checks, requests, errors }, null, 2),
  );
  console.log(JSON.stringify({ output, checks, requests }));
} catch (error) {
  console.error({ output, errors });
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  if (locked) await fs.chmod(locked, 0o700);
  await app
    ?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
    )
    .catch(() => {});
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
