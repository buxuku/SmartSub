import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';

const require = createRequire(import.meta.url);
const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-review-layout-'),
);
const source = path.join(output, 'design-lesson.en.srt');
const target = path.join(output, 'design-lesson.zh.srt');
const sidecar = path.join(output, 'design-lesson.json');
const media = path.join(output, 'design-lesson.mp4');
const stamp = (seconds) =>
  `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
const cues = Array.from({ length: 24 }, (_, index) => ({
  id: String(index + 1),
  startMs: (index * 6 + 1) * 1000,
  endMs: (index * 6 + 3) * 1000,
  source: `Line ${index + 1}. The silhouette of your character should remain clear and readable, even when the entire shape is filled with black.`,
  target: '角色的剪影应当清晰易读，即使整个形状都填充为黑色。',
}));
await fs.writeFile(
  source,
  cues
    .map(
      (c) =>
        `${c.id}\n${stamp(c.startMs / 1000)} --> ${stamp(c.endMs / 1000)}\n${c.source}\n`,
    )
    .join('\n'),
);
await fs.writeFile(
  target,
  cues
    .map(
      (c) =>
        `${c.id}\n${stamp(c.startMs / 1000)} --> ${stamp(c.endMs / 1000)}\n${c.target}\n`,
    )
    .join('\n'),
);
await fs.writeFile(
  sidecar,
  JSON.stringify({
    version: 2,
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceFile: source,
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    },
    speakers: [],
    cues,
    missedSpeechWarnings: [
      {
        id: 'missing',
        startMs: 3000,
        endMs: 6000,
        level: 'high',
        signals: ['speechReview'],
        cueIds: [],
        suggestedText: '',
      },
    ],
  }),
);
assert.equal(
  spawnSync(
    require('ffmpeg-static'),
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x34465b:s=640x360:r=1:d=150',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300:duration=150',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      media,
    ],
    { stdio: 'ignore' },
  ).status,
  0,
);
let app, page;
const errors = [];
try {
  app = await _electron.launch({
    args: ['.', '8888', `--user-data-dir=${path.join(output, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await waitForAppPage(page);
  page.on('pageerror', (error) => errors.push(String(error)));
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.closeDevTools());
    dialog.showMessageBoxSync = () => 0;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(
    async ({ source, target, media, sidecar }) => {
      const task = await window.ipc.invoke('createProofreadTask', {
        name: 'Design lesson review',
        items: [
          {
            sourceSubtitlePath: source,
            targetSubtitlePath: target,
            videoPath: media,
            proofreadDataFile: sidecar,
            sourceLanguage: 'en',
            targetLanguage: 'zh',
          },
        ],
      });
      if (!task.success) throw new Error(JSON.stringify(task));
      await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
    },
    { source, target, media, sidecar },
  );
  await page.getByRole('button', { name: '校对', exact: true }).click();
  const toolbar = page.locator('[data-edit-toolbar]');
  await expect(toolbar.locator('[data-ai-toolbar]')).toHaveCount(1);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await toolbar.boundingBox();
    assert.ok(
      bounds.height <= 52,
      `${width}: toolbar occupies one row (${bounds.height}px)`,
    );
    await expect(
      toolbar.getByRole('button', { name: 'AI 助手', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(output, `toolbar-${width}-dark.png`),
    });
  }
  await toolbar.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(page.locator('[data-ai-actions]')).toContainText(
    '全部字幕 · 24 条',
  );
  await expect(page.locator('[data-ai-actions]')).toContainText('确认后采纳');
  await page.screenshot({
    path: path.join(output, 'toolbar-ai-menu.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '提示词内容', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-ai-settings]')).toContainText('共用此服务');
  await page.screenshot({
    path: path.join(output, 'ai-settings-basic.png'),
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: '高级设置（可选）', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: '提示词内容', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: '要编辑的提示词模板', exact: true })
    .selectOption('sourceContent:batch:shorten');
  await expect(
    page.getByRole('textbox', { name: '提示词内容', exact: true }),
  ).toContainText('Use fewer characters');
  await page.screenshot({
    path: path.join(output, 'ai-settings-advanced.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '返回 AI 操作', exact: true }).click();
  await expect(page.locator('[data-ai-actions]')).toBeVisible();
  await page.keyboard.press('Escape');
  await toolbar.getByRole('button', { name: '视图', exact: true }).click();
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(0);
  await page.getByRole('button', { name: '展开面板', exact: true }).click();
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: '展开全部', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '收起全部', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '大', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '大', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({
    path: path.join(output, 'toolbar-view-menu.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '中', exact: true }).click();
  await page.getByRole('button', { name: '收起全部', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await page.screenshot({
    path: path.join(output, 'toolbar-wide-light.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await page.getByRole('tab', { name: /建议检查/ }).click();
  await expect(
    toolbar.getByRole('button', { name: 'AI 设置', exact: true }),
  ).toBeVisible();
  const panel = page.locator('[data-quality-panel]');
  const list = page.getByLabel('问题列表', { exact: true });
  const detail = page.locator('[data-quality-detail]');
  const content = page.locator('[data-quality-content]');
  await expect(list).toBeVisible();
  await expect(page.locator('#subtitle-src-0')).toBeVisible();
  const listBounds = await list.boundingBox();
  const contentBounds = await content.boundingBox();
  assert.ok(listBounds.height > 350, `navigation height ${listBounds.height}`);
  assert.ok(
    listBounds.x + listBounds.width <= contentBounds.x + 1,
    'list sits beside the editor',
  );
  await page.screenshot({ path: path.join(output, 'review-wide-dark.png') });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await expect(panel.getByText('正在检查…', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'review-wide-light.png') });
  await page.getByLabel('问题类型', { exact: true }).selectOption('speech');
  const gapContext = page.locator('[data-quality-gap-context]');
  await expect(gapContext).toBeVisible();
  await expect(
    gapContext.locator('[data-quality-context-side=before]'),
  ).toContainText('Line 1.');
  await expect(
    gapContext.locator('[data-quality-context-side=after]'),
  ).toContainText('Line 2.');
  await expect(gapContext).toContainText('角色的剪影');
  await expect(gapContext.locator('[data-quality-gap-marker]')).toContainText(
    '00:00:03.000 – 00:00:06.000',
  );
  await gapContext
    .getByRole('button', { name: '试听前后文', exact: true })
    .click();
  const video = page.locator('video');
  await expect
    .poll(() => video.evaluate((el) => el.currentTime), { timeout: 12000 })
    .toBeGreaterThan(7);
  await expect.poll(() => video.evaluate((el) => el.paused)).toBe(true);
  const contextEnd = await video.evaluate((el) => el.currentTime);
  assert.ok(
    contextEnd >= 10 && contextEnd < 10.5,
    `context playback end ${contextEnd}`,
  );
  await gapContext
    .getByRole('button', { name: '查看更多前后文', exact: true })
    .click();
  await expect(gapContext).toContainText('Line 3.');
  await gapContext
    .getByRole('button', { name: '只看前后各一句', exact: true })
    .click();
  await gapContext.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'speech-context-wide.png') });
  await page.getByRole('button', { name: '补一句字幕', exact: true }).click();
  const original = page.getByRole('textbox', { name: '补充原文', exact: true });
  await expect(original).toBeFocused();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue(
    '00:00:03.000',
  );
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveValue(
    '00:00:06.000',
  );
  await expect(gapContext).toBeAttached();
  await original.fill('Look at the negative space.');
  await page.getByRole('button', { name: '对照前后文', exact: true }).click();
  await expect(gapContext).toBeInViewport();
  await expect(original).toHaveValue('Look at the negative space.');
  await page
    .getByRole('textbox', { name: '补充译文（可选）', exact: true })
    .fill('注意观察负空间。');
  await page
    .getByRole('button', { name: '插入字幕', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'insert-wide-light.png') });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(list).not.toBeVisible();
  await expect(original).toHaveValue('Look at the negative space.');
  await gapContext.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'speech-context-1024.png') });
  const add = page.getByRole('button', { name: '插入字幕', exact: true });
  await add.scrollIntoViewIfNeeded();
  const addBounds = await add.boundingBox();
  const scrollBounds = await content.boundingBox();
  assert.ok(
    addBounds.y >= scrollBounds.y &&
      addBounds.y + addBounds.height <=
        scrollBounds.y + scrollBounds.height + 1,
    'insert action is reachable inside the detail scroll area',
  );
  assert.equal(
    await panel.evaluate((el) => el.scrollHeight > el.clientHeight + 1),
    false,
    'panel itself does not add another scrollbar',
  );
  assert.equal(
    await detail.evaluate((el) => el.scrollHeight > el.clientHeight + 1),
    false,
    'form is not clipped in a nested scroll area',
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: path.join(output, 'insert-1024-light.png') });
  await page.getByRole('button', { name: /问题列表/ }).click();
  await expect(list).toBeVisible();
  await page.getByLabel('问题类型', { exact: true }).selectOption('all');
  assert.ok(
    (await list.boundingBox()).height > 200,
    'narrow navigation has usable height',
  );
  await page.screenshot({ path: path.join(output, 'list-1024-light.png') });
  await page.getByLabel('问题类型', { exact: true }).selectOption('speech');
  await page.getByRole('button', { name: '返回当前问题', exact: true }).click();
  await expect(original).toHaveValue('Look at the negative space.');
  await page.getByLabel('开始时间', { exact: true }).fill('00:60:03.000');
  await add.click();
  await expect(
    page.getByRole('alert').filter({ hasText: '请输入有效时间码' }),
  ).toBeVisible();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(original).toHaveValue('Look at the negative space.');
  await page.getByLabel('开始时间', { exact: true }).fill('00:00:01.000');
  await add.click();
  await expect(
    page.getByRole('alert').filter({ hasText: '请输入文字和有效时段' }),
  ).toBeVisible();
  await expect(original).toHaveValue('Look at the negative space.');
  await page.getByLabel('开始时间', { exact: true }).fill('00:00:03.000');
  await add.click();
  await expect(page.locator('#subtitle-src-1')).toHaveValue(
    'Look at the negative space.',
  );
  await expect(
    detail.getByRole('button', { name: '恢复待检查', exact: true }),
  ).toBeVisible();

  await expect(
    detail.getByRole('button', { name: '标记已修复', exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByText('正在检查…', { exact: true })).toHaveCount(0);
  await expect(
    detail.getByRole('button', { name: '恢复待检查', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /撤销/ }).first().click();
  await expect(page.locator('#subtitle-src-1')).toHaveCount(0);
  await expect(
    detail.getByRole('button', { name: '确认无误', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /重做/ }).first().click();
  await expect(page.locator('#subtitle-src-1')).toHaveValue(
    'Look at the negative space.',
  );
  await expect(panel.getByText('正在检查…', { exact: true })).toHaveCount(0);
  await expect(
    detail.getByRole('button', { name: '恢复待检查', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '使用帮助', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('提示不一定是错误');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      output,
      checks: [
        'single toolbar at 1024/1440, AI scopes/settings and view controls',
        'wide navigation',
        'narrow navigation',
        'bilingual insertion',
        'gap context and surrounding playback',
        'single detail scroll',
        'draft retention',
        'atomic undo/redo',
        'help',
        'light/dark',
      ],
      errors,
    }),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error(output);
  throw error;
} finally {
  await app?.close();
}
