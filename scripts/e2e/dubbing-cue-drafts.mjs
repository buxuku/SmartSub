import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-cue-drafts-e2e-'),
);
const profile = path.join(output, 'profile');
const subtitle = path.join(output, 'drafts.srt');
const source = Array.from({ length: 100 }, (_, index) => {
  const time = (seconds) =>
    `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
  return `${index + 1}\n${time(index * 5)} --> ${time(index * 5 + 4)}\nOriginal sentence ${index + 1}.\n`;
}).join('\n');
await fs.writeFile(subtitle, source);
const audio = path.join(output, 'fixture.wav');
execFileSync(ffmpeg, [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=24000:duration=1',
  '-c:a',
  'pcm_s16le',
  audio,
]);
const wav = await fs.readFile(audio);
const requests = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app, page, locked;
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
        ipcMain._invokeHandlers.has('dubbing:saveCueTexts'),
      ),
    )
    .toBe(true);
  await app.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    const channel = 'dubbing:saveCueTexts';
    const original = ipcMain._invokeHandlers.get(channel);
    globalThis.textFault = '';
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (...args) => {
      if (globalThis.textFault === 'before')
        return { success: false, error: 'Injected text save failure' };
      const result = await original(...args);
      if (globalThis.textFault === 'after')
        throw new Error('Text acknowledgement lost');
      return result;
    });
  });
};
const go = (url) =>
  page.evaluate(
    (url) =>
      window.next.router.push(url).catch((error) => {
        if (!error?.cancelled) throw error;
      }),
    url,
  );
const banner = () => page.getByTestId('cue-draft-banner');
const row = (index) => page.getByTestId(`dubbing-cue-${index}`);
const edit = (index) => page.getByTestId(`dubbing-edit-${index}`);
const text = (index) =>
  page.getByRole('textbox', { name: `第 ${index + 1} 句文本`, exact: true });
const save = () =>
  banner().getByRole('button', { name: '保存全部文本', exact: true });
const kill = async () => {
  const process = app.process();
  const exited = once(process, 'exit');
  process.kill('SIGKILL');
  await exited;
  app = null;
};
try {
  await launch();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const session = await page.evaluate(
    async ({ subtitle, url }) => {
      window.ipc.send('setTtsProviders', [
        {
          id: 'cue-test',
          name: 'Cue test',
          type: 'openaiCompatible',
          apiKey: 'fixture',
          apiUrl: url,
          model: 'test',
          voices: 'voice',
        },
      ]);
      await window.ipc.invoke('getTtsProviders');
      localStorage.setItem(
        'dubbingConfig',
        JSON.stringify({
          engineKey: 'cloud:cue-test',
          voice: 'voice',
          globalSpeed: 1,
          output: 'audioOnly',
          audioFormat: 'wav',
          background: 'mute',
        }),
      );
      const result = await window.ipc.invoke('dubbing:loadSubtitle', {
        leaseId: 'fixture',
        subtitlePath: subtitle,
      });
      if (!result.success) throw new Error(result.error);
      await window.ipc.invoke('dubbing:disposeSession', {
        sessionId: result.data.sessionId,
        leaseId: 'fixture',
      });
      return result.data;
    },
    { subtitle, url: `http://127.0.0.1:${server.address().port}/v1` },
  );
  const route = `/zh/dubbing/?session=${session.sessionId}`;
  const root = await app.evaluate(({ app }) => app.getPath('userData'));
  const directory = path.join(root, 'dubbing-sessions', session.sessionId);
  const meta = async () =>
    JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8'));
  await go(route);
  await expect(
    page.getByRole('button', { name: '开始配音', exact: true }),
  ).toBeEnabled();
  await edit(0).click();
  await text(0).fill('First draft.');
  await edit(1).click();
  await text(1).fill('Second draft.');
  await edit(0).click();
  await expect(text(0)).toHaveValue('First draft.');
  await row(0).getByRole('button', { name: '收起', exact: true }).click();
  await edit(0).click();
  await expect(text(0)).toHaveValue('First draft.');
  const scroller = page.getByTestId('dubbing-cue-scroll');
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(row(0)).toHaveCount(0);
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(text(0)).toHaveValue('First draft.');
  await expect(
    page.getByRole('button', { name: '开始配音', exact: true }),
  ).toBeDisabled();
  assert.equal(requests.length, 0);
  checks.push(
    'Two independent drafts survive row switch, collapse and virtual unmount; generation is blocked',
  );

  locked = directory;
  await fs.chmod(locked, 0o500);
  await save().click();
  await expect(banner()).toContainText('EACCES');
  assert.equal((await meta()).cues[0].text, 'Original sentence 1.');
  await go('/zh/home/');
  const guard = page.getByRole('alertdialog');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(guard).toBeVisible();
  await expect(page).toHaveURL(/dubbing/);
  await guard.getByRole('button', { name: '留在当前页', exact: true }).click();
  await fs.chmod(locked, 0o700);
  locked = undefined;
  await save().click();
  await expect(banner()).toHaveCount(0);
  assert.equal((await meta()).cues[0].text, 'First draft.');
  assert.equal((await meta()).cues[1].text, 'Second draft.');
  assert.equal(requests.length, 0);
  assert.equal(await fs.readFile(subtitle, 'utf8'), source);
  checks.push(
    'Actual chmod save failure blocks navigation; retry saves both rows atomically without TTS or source subtitle writes',
  );

  await text(0).fill('Crash recovery text.');
  await app.evaluate(() => {
    globalThis.textFault = 'before';
  });
  await save().click();
  await expect(banner()).toContainText('Injected text save failure');
  await kill();
  await launch();
  await go(route);
  await expect(banner()).toContainText('发现 1 句未保存的文本草稿');
  await expect(
    page.getByRole('button', { name: '开始配音', exact: true }),
  ).toBeDisabled();
  await banner()
    .getByRole('button', { name: '恢复文本草稿', exact: true })
    .click();
  await edit(0).click();
  await expect(text(0)).toHaveValue('Crash recovery text.');
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
    await page.screenshot({ path: path.join(output, `draft-${width}.png`) });
  }
  await save().click();
  await expect(banner()).toHaveCount(0);
  assert.equal((await meta()).cues[0].text, 'Crash recovery text.');
  checks.push(
    'Immediate whole-app SIGKILL after failed save recovers text by explicit choice; 1024/1440 bounds',
  );

  await text(0).fill('Committed without acknowledgement.');
  await app.evaluate(() => {
    globalThis.textFault = 'after';
  });
  await save().click();
  await expect(banner()).toContainText('Text acknowledgement lost');
  await kill();
  await launch();
  await go(route);
  await expect(banner()).toContainText('发现 1 句未保存的文本草稿');
  await banner()
    .getByRole('button', { name: '放弃文本草稿', exact: true })
    .click();
  await expect(banner()).toHaveCount(0);
  await expect(edit(0)).toHaveText('Committed without acknowledgement.');
  assert.equal(
    (await meta()).cues[0].text,
    'Committed without acknowledgement.',
  );
  assert.equal(requests.length, 0);
  checks.push(
    'Lost project acknowledgement plus SIGKILL, then discard, retains confirmed project text',
  );

  await edit(0).click();
  await text(0).fill('Generate this saved sentence.');
  await row(0)
    .getByRole('button', { name: '保存并重合成', exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(1);
  await expect.poll(async () => (await meta()).cues[0].status).toBe('done');
  assert.equal(requests[0].input, 'Generate this saved sentence.');
  await expect(banner()).toHaveCount(0);
  await edit(0).click();
  await text(0).fill('Changed after audio.');
  await row(0).getByRole('button', { name: '保存文本', exact: true }).click();
  await expect(banner()).toHaveCount(0);
  assert.equal((await meta()).cues[0].needsUpdate, true);
  assert.equal(requests.length, 1);
  assert.equal(await fs.readFile(subtitle, 'utf8'), source);
  checks.push(
    'Save-and-regenerate calls real fixture TTS once; later text-only save invalidates existing audio without synthesis',
  );
  await text(0).fill('Unsaved retained across filter.');
  await page.getByRole('button', { name: '需更新 1', exact: true }).click();
  await expect(text(0)).toHaveValue('Unsaved retained across filter.');
  await page.getByRole('button', { name: '全部 100', exact: true }).click();
  await expect(text(0)).toHaveValue('Unsaved retained across filter.');
  await banner()
    .getByRole('button', { name: '放弃文本草稿', exact: true })
    .click();
  await expect(text(0)).toHaveValue('Changed after audio.');
  await text(0).fill('Conflict draft.');
  await app.evaluate(() => {
    globalThis.textFault = 'before';
  });
  await save().click();
  await expect(banner()).toContainText('Injected text save failure');
  await kill();
  const changed = await meta();
  changed.cues[0].text = 'Externally confirmed text.';
  await fs.writeFile(
    path.join(directory, 'session.json'),
    JSON.stringify(changed),
  );
  await launch();
  await go(route);
  await banner()
    .getByRole('button', { name: '恢复文本草稿', exact: true })
    .click();
  await edit(0).click();
  await expect(row(0)).toContainText(
    '已保存文本发生变化：Externally confirmed text.',
  );
  await save().click();
  await expect(banner()).toContainText('changed; review');
  assert.equal((await meta()).cues[0].text, 'Externally confirmed text.');
  await row(0)
    .getByRole('button', { name: '确认保留我的文本', exact: true })
    .click();
  await save().click();
  await expect(banner()).toHaveCount(0);
  assert.equal((await meta()).cues[0].text, 'Conflict draft.');
  assert.equal(requests.length, 1);
  checks.push(
    'Filter changes retain input; recovered conflicting text cannot overwrite current project until explicit confirmation',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ output, checks, requests: requests.length }, null, 2),
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-12000));
  }
  console.error('Evidence:', output);
  throw error;
} finally {
  if (locked) await fs.chmod(locked, 0o700);
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
}
