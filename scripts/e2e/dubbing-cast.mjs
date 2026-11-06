import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-dubbing-cast-e2e-'),
);
const subtitle = path.join(output, 'cast.srt');
const sidecar = path.join(output, 'roles.json');
const voice = path.join(output, 'voice.wav');
execFileSync(ffmpeg, [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000:duration=3',
  '-c:a',
  'pcm_s16le',
  voice,
]);
const bytes = await fs.readFile(voice);
const texts = [
  'First host sentence.',
  'Second host sentence.',
  'Guest sentence.',
];
await fs.writeFile(
  subtitle,
  texts
    .map(
      (text, i) =>
        `${i + 1}\n00:00:${String(i * 10).padStart(2, '0')},000 --> 00:00:${String((i + 1) * 10).padStart(2, '0')},000\n${text}`,
    )
    .join('\n\n'),
);
await fs.writeFile(
  sidecar,
  JSON.stringify({
    version: 2,
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceFile: subtitle,
    },
    speakers: [
      { id: 1, displayName: 'Host', color: '#218C74' },
      { id: 2, displayName: 'Guest', color: '#DA4167' },
    ],
    cues: texts.map((text, i) => ({
      id: String(i + 1),
      startMs: i * 10000,
      endMs: (i + 1) * 10000,
      source: text,
      target: '',
      speakerIds: [i === 2 ? 2 : 1],
    })),
  }),
);
const requests = [];
const server = http.createServer((request, response) => {
  if (request.url !== '/v1/audio/speech') return response.writeHead(404).end();
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(bytes);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app, page;
let lockedDirectory;
const errors = [];
async function launch() {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
}
try {
  await launch();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const config = {
    engine: { kind: 'cloud', providerId: 'cast-test' },
    voice: 'alloy',
    globalSpeed: 1,
    background: 'mute',
    output: 'audioOnly',
    language: 'en',
    audioFormat: 'wav',
    overflow: 'truncate',
    overlapMode: 'shift',
    exportShiftedSubtitle: false,
  };
  const session = await page.evaluate(
    async ({ subtitle, sidecar, url, config }) => {
      window.ipc.send('setTtsProviders', [
        {
          id: 'cast-test',
          name: 'Cast test',
          type: 'openaiCompatible',
          apiKey: 'test-only',
          apiUrl: url,
          model: 'test',
          voices: 'alloy,echo',
        },
      ]);
      await window.ipc.invoke('getTtsProviders');
      localStorage.setItem(
        'dubbingConfig',
        JSON.stringify({ ...config, engineKey: 'cloud:cast-test' }),
      );
      const loaded = await window.ipc.invoke('dubbing:loadSubtitle', {
        leaseId: 'fixture',
        subtitlePath: subtitle,
        proofreadDataFile: sidecar,
      });
      if (!loaded.success) throw new Error(loaded.error);
      await window.ipc.invoke('dubbing:disposeSession', {
        sessionId: loaded.data.sessionId,
        leaseId: 'fixture',
      });
      return loaded.data;
    },
    {
      subtitle,
      sidecar,
      url: `http://127.0.0.1:${server.address().port}/v1`,
      config,
    },
  );
  assert.equal(session.speakers.length, 2);
  const open = () =>
    page.evaluate(
      (id) => window.next.router.push(`/zh/dubbing/?session=${id}`),
      session.sessionId,
    );
  await open();
  let host = page.locator('[data-speaker-card="1"]');
  let guest = page.locator('[data-speaker-card="2"]');
  await expect(host).toBeVisible();
  for (const [card, name] of [
    [host, 'Host'],
    [guest, 'Guest'],
  ]) {
    await card.getByRole('combobox', { name: `为${name}选择音色` }).click();
    await page
      .getByRole('button', { name: '使用全局默认音色', exact: true })
      .click();
    await expect(card.getByRole('combobox')).toContainText('使用全局默认音色');
  }
  const snapshot = () =>
    page.evaluate(
      (sessionId) => window.ipc.invoke('dubbing:getSession', { sessionId }),
      session.sessionId,
    );
  const draftSpeed = host.getByRole('spinbutton', {
    name: '语速',
    exact: true,
  });
  await draftSpeed.fill('1.25');
  await draftSpeed.press('Enter');
  await expect
    .poll(async () => (await snapshot()).data.speakerSettings?.['1']?.speed)
    .toBe(1.25);
  assert.equal(requests.length, 0, 'draft has no generated audio');
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  const sessionDir = path.join(userData, 'dubbing-sessions', session.sessionId);
  const readMeta = async () =>
    JSON.parse(
      await fs.readFile(path.join(sessionDir, 'session.json'), 'utf8'),
    );
  const readItems = () =>
    page.evaluate(() => window.ipc.invoke('getWorkItems'));
  const workItem = (await readItems()).find(
    (item) => item.configSnapshot?.sessionId === session.sessionId,
  );
  assert.ok(workItem, 'unsynthesized draft is discoverable');
  assert.equal((await readMeta()).speakerSettings['1'].speed, 1.25);
  const disk = JSON.parse(
    await fs.readFile(path.join(output, 'profile', 'config.json'), 'utf8'),
  );
  assert.ok(
    disk.workItems.some((item) => item.id === workItem.id),
    'draft task is durable before synthesis',
  );
  const openRecent = async () => {
    await page.evaluate(() => window.next.router.push('/zh/recent-tasks/'));
    await page.getByText('cast.srt', { exact: true }).click();
    await page.waitForURL(/\/dubbing\/?\?/);
  };
  await openRecent();
  await expect(draftSpeed).toHaveValue('1.25');
  // No graceful shutdown hooks: acknowledged role-only edits must survive a crash.
  const electronProcess = app.process();
  const exited = new Promise((resolve) =>
    electronProcess.once('exit', resolve),
  );
  electronProcess.kill('SIGKILL');
  await exited;
  app = undefined;
  await launch();
  await openRecent();
  host = page.locator('[data-speaker-card="1"]');
  guest = page.locator('[data-speaker-card="2"]');
  await expect(
    host.getByRole('spinbutton', { name: '语速', exact: true }),
  ).toHaveValue('1.25');
  await expect(guest.getByRole('combobox')).toContainText('使用全局默认音色');
  assert.equal(
    (await readItems()).filter(
      (item) => item.configSnapshot?.sessionId === session.sessionId,
    ).length,
    1,
    'restore does not duplicate tasks',
  );
  if (process.platform !== 'win32') {
    lockedDirectory = sessionDir;
    await fs.chmod(lockedDirectory, 0o500);
    await host.getByRole('combobox').click();
    await page.getByRole('button', { name: 'echo', exact: true }).click();
    await expect(
      page.getByRole('dialog').getByRole('alert').filter({ hasText: 'EACCES' }),
    ).toBeVisible();
    await expect(
      host.getByRole('combobox', { includeHidden: true }),
    ).toContainText('使用全局默认音色');
    assert.equal((await readMeta()).speakerVoiceMap['1'], '__global__');
    await fs.chmod(lockedDirectory, 0o700);
    lockedDirectory = undefined;
    await page.getByRole('button', { name: 'echo', exact: true }).click();
    await expect(host.getByRole('combobox')).toContainText('echo');
    assert.equal((await readMeta()).speakerVoiceMap['1'], 'echo');
    await host.getByRole('combobox').click();
    await page
      .getByRole('button', { name: '使用全局默认音色', exact: true })
      .click();
  }
  await host.getByRole('spinbutton', { name: '语速', exact: true }).fill('1');
  await host
    .getByRole('spinbutton', { name: '语速', exact: true })
    .press('Enter');
  await expect
    .poll(async () => (await snapshot()).data.speakerSettings?.['1']?.speed)
    .toBe(1);
  await expect(
    page.getByRole('button', { name: '开始配音', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '开始配音', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot()).data.cues.filter((cue) => cue.status === 'done')
          .length,
    )
    .toBe(3);
  const initial = (await snapshot()).data;
  const before = requests.length;
  const speed = host.getByRole('spinbutton', { name: '语速', exact: true });
  const pitch = host.getByRole('spinbutton', {
    name: '音高 (半音)',
    exact: true,
  });
  await speed.fill('1.5');
  await speed.press('Enter');
  await expect
    .poll(async () => (await snapshot()).data.speakerSettings?.['1']?.speed)
    .toBe(1.5);
  await expect(pitch).toBeEnabled();
  await pitch.fill('12');
  await pitch.press('Enter');
  await expect
    .poll(async () => (await snapshot()).data.speakerSettings?.['1']?.pitch)
    .toBe(12);
  await expect(host.getByText('2 句需要更新', { exact: true })).toBeVisible();
  assert.equal((await snapshot()).data.cues[2].needsUpdate, false);
  await host
    .getByRole('button', { name: '重新生成此角色', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await snapshot()).data.cues.filter((cue) => cue.needsUpdate).length,
    )
    .toBe(0);
  const generated = (await snapshot()).data;
  assert.equal(requests.length - before, 2);
  assert.equal(generated.cues[2].wavPath, initial.cues[2].wavPath);
  assert.ok(Math.abs(generated.cues[0].synthesizedMs - 2000) < 90);
  const pcm = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-i',
    generated.cues[0].wavPath,
    '-f',
    's16le',
    '-ac',
    '1',
    '-ar',
    '24000',
    'pipe:1',
  ]);
  let crossings = 0;
  for (let i = 4801; i < pcm.length / 2 - 4800; i++)
    if (pcm.readInt16LE((i - 1) * 2) <= 0 && pcm.readInt16LE(i * 2) > 0)
      crossings++;
  const frequency = (crossings * 24000) / (pcm.length / 2 - 9600);
  assert.ok(Math.abs(frequency - 880) < 4, `generated pitch ${frequency}`);
  const beforeCastPreview = requests.length;
  await page.getByRole('button', { name: '试听角色阵容', exact: true }).click();
  await expect
    .poll(() => requests.length, { timeout: 10000 })
    .toBe(beforeCastPreview + 2);
  await expect(
    page.getByRole('button', { name: '试听角色阵容', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: '试听角色阵容', exact: true }).click();
  await page
    .getByRole('button', { name: '停止试听', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('button', { name: '试听角色阵容', exact: true }),
  ).toBeVisible();
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, voice);
  await page
    .getByRole('button', { name: '选择视频/音频（可选）', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '清除视频', exact: true }),
  ).toBeVisible();
  assert.equal((await snapshot()).data.videoPath, voice);
  assert.equal(
    (await snapshot()).data.cues[0].wavPath,
    generated.cues[0].wavPath,
  );
  await openRecent();
  await expect(
    page.getByRole('button', { name: '清除视频', exact: true }),
  ).toBeVisible();
  await expect(
    host.getByRole('spinbutton', { name: '语速', exact: true }),
  ).toHaveValue('1.5');
  await page.getByRole('button', { name: '清除视频', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '选择视频/音频（可选）', exact: true }),
  ).toBeVisible();
  assert.equal((await snapshot()).data.videoPath, undefined);
  assert.equal(
    (await snapshot()).data.cues[0].wavPath,
    generated.cues[0].wavPath,
  );
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await host.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await expect(speed).toBeVisible();
    await page.screenshot({ path: path.join(output, `cast-${width}.png`) });
  }
  await page.evaluate(() => window.next.router.push('/zh/home/'));
  await page.waitForURL(/\/home\/?$/);
  await open();
  await expect(speed).toHaveValue('1.5');
  await expect(pitch).toHaveValue('12');
  await page.evaluate(() => window.next.router.push('/zh/home/'));
  await page.waitForURL(/\/home\/?$/);
  const roles = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  roles.cues[2].speakerIds = [1];
  await fs.writeFile(sidecar, JSON.stringify(roles));
  await openRecent();
  await expect(host.getByRole('alert')).toContainText(
    '合并角色的语速/音高不同',
  );
  await expect(
    page.getByRole('button', { name: '继续合成', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '导出', exact: true }),
  ).toBeDisabled();
  const conflict = (await snapshot()).data.speakerSettingsConflicts['1'];
  assert.deepEqual(conflict, [
    { speed: 1.5, pitch: 12 },
    { speed: 1, pitch: 0 },
  ]);
  await host
    .getByRole('button', { name: '使用 1.5x / 12 半音', exact: true })
    .click();
  await expect(host.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(async () => (await snapshot()).data.speakerSettingsConflicts)
    .toEqual({});
  assert.equal((await snapshot()).data.cues[2].needsUpdate, true);
  await page.screenshot({
    path: path.join(output, 'merged-role-confirmed.png'),
  });
  assert.deepEqual(errors, []);
  const result = {
    output,
    requests: requests.length,
    frequency,
    checks:
      'top cast, explicit role binding, pre-synthesis recent-task recovery and SIGKILL restart, real permission failure rollback/retry, actual rate/pitch generation, role-only stale/regeneration, unchanged guest artifact, media attach/reopen/remove preserves session and audio, merged-role settings confirmation, 1024/1440 and leave/reopen persistence; TTS endpoint is a local deterministic fixture',
  };
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error({ output });
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  if (lockedDirectory) await fs.chmod(lockedDirectory, 0o700);
  await app?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
