/* Isolated production UI check; no real tasks or user profiles are edited. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron, expect } from '@playwright/test';
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-speech-review-ui-'),
);
const original = path.join(output, 'original.srt');
const source = path.join(output, 'reviewed.srt');
await fs.writeFile(
  original,
  '1\n00:00:01,000 --> 00:00:02,000\nOriginal words.\n',
);
await fs.writeFile(
  source,
  '1\n00:00:01,000 --> 00:00:03,000\nOriginal words. Recovered sentence.\n',
);
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${path.join(output, 'profile')}`],
  env: { ...process.env, NODE_ENV: 'production' },
});
let page;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForURL(/^app:\/\//);
  await app.evaluate(({ dialog, shell }) => {
    dialog.showMessageBoxSync = () => 0;
    shell.showItemInFolder = (p) => {
      globalThis.reviewRevealed = p;
    };
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const id = await page.evaluate(
    async ({ source, original, output }) => {
      const config = {
        ...(await window.ipc.invoke('getUserConfig')),
        taskType: 'generateOnly',
      };
      const file = {
        uuid: 'review-ui',
        fileName: 'Review fixture',
        filePath: '/fixture.wav',
        fileExtension: '.wav',
        directory: output,
        srtFile: source,
        extractAudio: 'done',
        extractSubtitle: 'done',
        speechReviewOriginalFile: original,
        speechReviewSummary: {
          status: 'complete',
          recovered: 1,
          retimed: 1,
          changes: [
            { start: 2, end: 3, original: '', text: 'Recovered sentence.' },
          ],
        },
      };
      const task = await window.ipc.invoke('saveTaskProject', {
        id: 'speech-review-ui-project',
        name: 'Speech review fixture',
        taskType: 'generateOnly',
        files: [file],
        taskDraft: { config, manuscripts: [] },
        preserveTaskProgress: true,
      });
      if (!task?.id) throw Error(JSON.stringify(task));
      await window.next.router.push(`/zh/tasks/generate/?project=${task.id}`);
      return task.id;
    },
    { source, original, output },
  );
  await page.getByRole('button', { name: '已补回 1 段', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Recovered sentence.');
  await expect(page.getByRole('dialog')).toContainText('已校正 1 段时间');
  for (const width of [1024, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, 800),
      width,
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({ path: path.join(output, `review-${width}.png`) });
  }
  await page.getByRole('button', { name: '查看复核前字幕备份' }).click();
  assert.equal(await app.evaluate(() => globalThis.reviewRevealed), original);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: '已补回 1 段', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Recovered sentence.');
  await page.keyboard.press('Escape');
  const sidecar = path.join(output, 'proofread.json');
  await fs.writeFile(
    sidecar,
    JSON.stringify({
      version: 2,
      meta: {},
      speakers: [],
      cues: [
        {
          id: '1',
          startMs: 1000,
          endMs: 3000,
          source: 'Original words.',
          target: '',
        },
      ],
      missedSpeechWarnings: [
        {
          id: 'w',
          startMs: 3200,
          endMs: 3500,
          level: 'high',
          signals: ['speechReview', 'textMismatch'],
          cueIds: [],
          originalText: 'Original uncertain phrase.',
          suggestedText: 'Quiet phrase.',
        },
      ],
    }),
  );
  await page.evaluate(
    async ({ source, sidecar }) => {
      const response = await window.ipc.invoke('createProofreadTask', {
        name: 'Review suggestion',
        items: [
          {
            sourceSubtitlePath: source,
            sourceLanguage: 'en',
            proofreadDataFile: sidecar,
          },
        ],
      });
      if (!response.success) throw Error(JSON.stringify(response));
      await window.next.router.push(
        `/zh/proofread/?workItem=${response.data.id}`,
      );
    },
    { source, sidecar },
  );
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await expect(page.getByTestId('missed-speech-controls')).toContainText(
    'Quiet phrase.',
  );
  await expect(page.getByTestId('missed-speech-controls')).toContainText(
    'Original uncertain phrase.',
  );
  await expect(page.getByTestId('missed-speech-controls')).toContainText(
    '两次识别文字不一致',
  );
  await expect(page.getByTestId('missed-speech-controls')).toContainText(
    '待复核 1 处',
  );
  const previousClipboard = await app.evaluate(({ clipboard }) => ({
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
  }));
  await page.getByRole('button', { name: '复制候选文字', exact: true }).click();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    'Quiet phrase.',
  );
  await app.evaluate(
    ({ clipboard }, data) => clipboard.write(data),
    previousClipboard,
  );
  await page.screenshot({ path: path.join(output, 'suggestion.png') });
  console.log(
    JSON.stringify({
      output,
      id,
      checks: [
        'changes visible',
        'backup action',
        'reload persistence',
        '1024 and 1440 layout',
        'proofread suggestion persistence and copy',
      ],
    }),
  );
} finally {
  await app.close();
}
