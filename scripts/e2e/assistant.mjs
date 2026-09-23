import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { _electron, expect } from '@playwright/test';
import { waitForAppPage } from './app-page.mjs';
expect.configure({ timeout: 30000 });

const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-assistant-e2e-'),
);
const source = path.join(directory, 'source.en.srt');
const target = path.join(directory, 'target.fr.srt');
const notes = path.join(directory, 'notes.md');
const picture = path.join(directory, 'picture.png');
await fs.writeFile(notes, '# Attachment\nThe project deadline is Friday.\n');
await fs.writeFile(
  picture,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
);
await fs.writeFile(source, '1\n00:00:00,000 --> 00:00:02,000\nHello world.\n');
await fs.writeFile(
  target,
  '1\n00:00:00,000 --> 00:00:02,000\nBonjour monde.\n',
);
const requests = [];
let held;
let sequence = 0;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  const userMessages = body.messages.filter(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      !message.content.startsWith('Attached files') &&
      !message.content.startsWith('Workspace data') &&
      !message.content.startsWith('Current revision'),
  );
  const user = userMessages.at(-1)?.content || '';
  const contextMessage = body.messages
    .filter(
      (message) =>
        typeof message.content === 'string' &&
        message.content.startsWith(
          'Current revision of captured workspace DATA:',
        ),
    )
    .at(-1);
  const context = contextMessage
    ? JSON.parse(contextMessage.content.split('\n').slice(1).join('\n'))
    : null;
  const start = body.messages.findLastIndex(
    (message) => message.role === 'user' && message.content === user,
  );
  const results = body.messages
    .slice(start)
    .filter((message) => message.role === 'tool');
  const respond = () => {
    let tool;
    let content = 'Fixture complete.';
    if (user === 'Analyze files')
      content =
        '# File analysis\n\nThe deadline is **Friday**.\n\n- Local file paths received\n- Image received\n\n| File | Result |\n| --- | --- |\n| Notes | Ready |\n\n```json\n{"deadline":"Friday"}\n```';
    if (!results.length && user.startsWith('Edit')) {
      tool = {
        name: 'assistant_editor_edit',
        arguments: JSON.stringify({
          documentId: context.editor.documentId,
          expectedRevision: context.editor.revision,
          edits: [
            { index: 0, field: 'targetContent', text: 'Salut tout le monde.' },
          ],
        }),
      };
    } else if (!results.length && user === 'Save') {
      tool = {
        name: 'assistant_editor_save',
        arguments: JSON.stringify({
          documentId: context.editor.documentId,
          expectedRevision: context.editor.revision,
        }),
      };
    } else if (user === 'Read attached subtitles') {
      if (!results.length)
        tool = {
          name: 'assistant_load_tools',
          arguments: '{"names":["subtitles.read"]}',
        };
      else if (results.length === 1) {
        const attachmentMessage = body.messages
          .slice(start)
          .find(
            (message) =>
              typeof message.content === 'string' &&
              message.content.startsWith('Attached files'),
          );
        const files = JSON.parse(
          attachmentMessage.content.split('\n').slice(1).join('\n'),
        );
        tool = {
          name: 'smartsub_subtitles_read',
          arguments: JSON.stringify({ filePath: files[0].path }),
        };
      } else content = 'Subtitles inspected through MCP.';
    } else if (user === 'Models') {
      if (!results.length)
        tool = {
          name: 'assistant_load_tools',
          arguments: '{"names":["models.list"]}',
        };
      else if (results.length === 1)
        tool = { name: 'smartsub_models_list', arguments: '{}' };
      else content = 'Models inspected.';
    } else if (user === 'Fail') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'Fixture unsupported tools' } }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (tool) {
      const half = Math.floor(tool.arguments.length / 2);
      emit({
        tool_calls: [
          {
            index: 0,
            id: `call-${++sequence}`,
            type: 'function',
            function: {
              name: tool.name,
              arguments: tool.arguments.slice(0, half),
            },
          },
        ],
      });
      emit({
        tool_calls: [
          { index: 0, function: { arguments: tool.arguments.slice(half) } },
        ],
      });
      emit({}, 'tool_calls');
    } else {
      emit({ content: content.slice(0, 8) });
      emit({ content: content.slice(8) });
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  };
  if (user === 'Edit held' && !results.length) {
    held = respond;
    return;
  }
  if (user === 'Stop me') {
    req.on('close', () => {});
    return;
  }
  respond();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
let page;
const pageErrors = [];
const launch = async () => {
  const env = {
    ...process.env,
    NODE_ENV: process.argv.includes('--production')
      ? 'production'
      : 'development',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8893',
      `--automation-data-dir=${path.join(directory, 'profile')}`,
    ],
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(30000);
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    ),
  );
};
try {
  await launch();
  const skip = page.getByRole('button', { name: '跳过', exact: true });
  await skip.waitFor({ state: 'visible', timeout: 15000 });
  await skip.click();
  await page.evaluate(async () => {
    const existing = await window.ipc.invoke('getTranslationProviders');
    await window.ipc.invoke('setTranslationProviders', {
      providers: [],
      expectedProviders: existing,
    });
  });
  await page
    .locator('header')
    .getByRole('button', { name: 'AI 助手', exact: true })
    .click();
  const panel = page.getByTestId('assistant-panel');
  await panel.getByRole('textbox').fill('Edit');
  await expect(
    panel.getByRole('button', { name: '发送', exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole('button', {
      name: '前往翻译服务配置支持工具调用的 AI 模型',
      exact: true,
    })
    .click();
  await expect.poll(() => page.url()).toContain('/zh/translation');
  await page.evaluate(
    async ({ source, target, url }) => {
      const providers = [
        {
          id: 'assistant-fixture',
          name: 'Assistant fixture',
          type: 'openai',
          isAi: true,
          apiUrl: url,
          apiKey: 'test-only',
          modelName: 'fixture',
          prompt: '${content}',
        },
      ];
      const existing = await window.ipc.invoke('getTranslationProviders');
      const saved = await window.ipc.invoke('setTranslationProviders', {
        providers,
        expectedProviders: existing,
      });
      if (saved?.success === false) throw new Error(JSON.stringify(saved));
      const task = await window.ipc.invoke('createProofreadTask', {
        name: 'Assistant test',
        items: [
          {
            sourceSubtitlePath: source,
            targetSubtitlePath: target,
            sourceLanguage: 'en',
            targetLanguage: 'fr',
          },
        ],
      });
      await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
    },
    { source, target, url: `http://127.0.0.1:${server.address().port}/v1` },
  );
  await expect(
    panel.getByRole('combobox', { name: 'AI 服务', exact: true }),
  ).toHaveValue('assistant-fixture');
  await expect(
    panel.getByRole('button', { name: '发送', exact: true }),
  ).toBeEnabled();
  console.log(
    '✓ manual provider save refreshes the open assistant and enables sending',
  );
  await panel.getByRole('button', { name: '收起助手' }).click();
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByText('Hello world.', { exact: true }).click();
  await page
    .locator('header')
    .getByRole('button', { name: 'AI 助手', exact: true })
    .click();
  const send = async (text) => {
    await panel.getByRole('textbox').fill(text);
    await panel.getByRole('button', { name: '发送', exact: true }).click();
  };
  const waitIdle = async () => {
    await expect(
      panel.getByRole('button', { name: '停止', exact: true }),
    ).toHaveCount(0);
  };
  await send('Edit');
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Salut tout le monde.',
  );
  await waitIdle();
  assert.ok((await fs.readFile(target, 'utf8')).includes('Bonjour monde.'));
  await page.locator('#subtitle-tgt-0').focus();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  );
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue('Bonjour monde.');
  console.log(
    '✓ streamed chat edits the correct draft and supports undo without saving',
  );
  await send('Edit held');
  await expect.poll(() => !!held).toBe(true);
  await panel.getByRole('button', { name: '收起助手' }).click();
  await page.locator('#subtitle-tgt-0').fill('Manual concurrent edit.');
  held();
  held = undefined;
  await page
    .locator('header')
    .getByRole('button', { name: 'AI 助手', exact: true })
    .click();
  await expect(panel.getByTestId('assistant-tool').last()).toContainText(
    'EDITOR_CONTEXT_CONFLICT',
  );
  await waitIdle();
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Manual concurrent edit.',
  );
  console.log('✓ concurrent manual changes reject the stale AI write');
  await send('Edit');
  await expect(page.locator('#subtitle-tgt-0')).toHaveValue(
    'Salut tout le monde.',
  );
  await waitIdle();
  await send('Save');
  await waitIdle();
  await expect
    .poll(async () =>
      (await fs.readFile(target, 'utf8')).includes('Salut tout le monde.'),
    )
    .toBe(true);
  console.log('✓ explicit save persists the edited subtitle');
  await send('Models');
  await expect(panel).toContainText('Models inspected.', { timeout: 60000 });
  await waitIdle();
  console.log(
    '✓ dynamically loaded automation tool executes through the real shared service',
  );
  await send('Edit held');
  await expect.poll(() => !!held).toBe(true);
  await page.evaluate(() => window.next.router.push('/zh/translation/'));
  held();
  held = undefined;
  await expect(panel.getByTestId('assistant-tool').last()).toContainText(
    'EDITOR_UNAVAILABLE',
  );
  await waitIdle();
  assert.ok(
    (await fs.readFile(target, 'utf8')).includes('Salut tout le monde.'),
  );
  console.log('✓ navigating away refuses the old editor command');
  await send('Stop me');
  await expect(
    panel.getByRole('button', { name: '停止', exact: true }),
  ).toBeVisible();
  await panel.getByRole('button', { name: '停止', exact: true }).click();
  await waitIdle();
  await expect(panel).toContainText('本轮已停止');
  await panel.getByRole('button', { name: '新建会话', exact: true }).click();
  await send('Fail');
  await expect(panel).toContainText('Fixture unsupported tools');
  assert.ok(requests.every((body) => body.stream && !body.response_format));
  const histories = await page.evaluate(() =>
    window.ipc.invoke('assistant:list'),
  );
  assert.equal(histories.length, 2);
  await page.screenshot({ path: path.join(directory, 'assistant.png') });
  await app.close();
  app = undefined;
  await launch();
  const restored = await page.evaluate(() =>
    window.ipc.invoke('assistant:list'),
  );
  assert.equal(restored.length, 2);
  const first = await page.evaluate(
    (id) => window.ipc.invoke('assistant:get', { id }),
    histories.find((item) => item.title === 'Edit').id,
  );
  assert.ok(
    first.messages.some((message) => message.content === 'Models inspected.'),
  );
  await page
    .locator('header')
    .getByRole('button', { name: 'AI 助手', exact: true })
    .click();
  const restoredPanel = page.getByTestId('assistant-panel');
  await expect(
    restoredPanel.getByTestId('assistant-history-overlay'),
  ).toHaveCount(0);
  await restoredPanel
    .getByRole('button', { name: '会话历史', exact: true })
    .click();
  await restoredPanel.locator(`[data-session-id="${first.id}"]`).click();
  await expect(
    restoredPanel.getByTestId('assistant-history-overlay'),
  ).toHaveCount(0);
  await expect(restoredPanel).toContainText('Models inspected.');
  await page.evaluate(() => window.next.router.push('/zh/translation/'));
  await expect(restoredPanel).toContainText('Models inspected.');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1600, 950),
  );
  await expect(restoredPanel).toBeVisible();
  const mainBox = await page.locator('main').boundingBox();
  const panelBox = await restoredPanel.boundingBox();
  assert.ok(
    mainBox.x + mainBox.width <= panelBox.x + 1,
    'wide layout should place panel beside workspace',
  );
  await page.screenshot({ path: path.join(directory, 'assistant-wide.png') });
  await restoredPanel
    .getByRole('button', { name: '会话历史', exact: true })
    .click();
  await restoredPanel
    .getByRole('button', { name: '删除会话', exact: true })
    .click();
  await restoredPanel
    .getByRole('button', { name: '删除会话', exact: true })
    .last()
    .click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.ipc.invoke('assistant:list'))).length,
    )
    .toBe(1);
  console.log(
    '✓ cancellation, service errors, multiple sessions and restart recovery',
  );
  await page.evaluate(async (source) => {
    const task = await window.ipc.invoke('createProofreadTask', {
      name: 'Source-only assistant test',
      items: [{ sourceSubtitlePath: source, sourceLanguage: 'en' }],
    });
    await window.next.router.push(`/zh/proofread/?workItem=${task.data.id}`);
  }, source);
  await page.getByRole('button', { name: '校对', exact: true }).click();
  await page.getByText('Hello world.', { exact: true }).click();
  await page
    .locator('header')
    .getByRole('button', { name: 'AI 助手', exact: true })
    .click();
  await restoredPanel
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await restoredPanel.getByRole('textbox').fill('Edit');
  await restoredPanel
    .getByRole('button', { name: '发送', exact: true })
    .click();
  await expect(
    restoredPanel.getByTestId('assistant-tool').last(),
  ).toContainText('SUBTITLE_FIELD_UNAVAILABLE');
  await expect(
    restoredPanel.getByRole('button', { name: '停止', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('#subtitle-tgt-0')).toHaveCount(0);
  const sourceContext = requests
    .at(-1)
    .messages.findLast((message) =>
      message.content?.startsWith(
        'Current revision of captured workspace DATA:',
      ),
    );
  assert.deepEqual(
    JSON.parse(sourceContext.content.split('\n').slice(1).join('\n')).editor
      .editableFields,
    ['sourceContent'],
  );
  await restoredPanel.getByRole('textbox').fill('Save');
  await restoredPanel
    .getByRole('button', { name: '发送', exact: true })
    .click();
  await expect(
    restoredPanel.getByTestId('assistant-tool').last(),
  ).toContainText('"saved": true');
  assert.ok((await fs.readFile(source, 'utf8')).includes('Hello world.'));
  console.log(
    '✓ source-only documents reject translations before draft mutation or save',
  );
  await restoredPanel
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await restoredPanel.getByRole('checkbox').uncheck();
  const beforeResize = await restoredPanel.boundingBox();
  const handle = await restoredPanel.getByRole('separator').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x - 150, handle.y + 100, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await restoredPanel.boundingBox()).width)
    .toBeGreaterThan(beforeResize.width + 100);
  await restoredPanel
    .locator('input[type=file]')
    .setInputFiles([notes, picture, source]);
  await expect(restoredPanel.getByTestId('assistant-attachment')).toHaveCount(
    3,
  );
  await restoredPanel.getByRole('textbox').fill('Analyze files');
  await page.locator('header').getByText('校对', { exact: true }).click();
  await expect(restoredPanel).toHaveCount(0);
  await page
    .locator('header')
    .getByRole('button', { name: 'AI 助手', exact: true })
    .click();
  await expect(restoredPanel.getByTestId('assistant-attachment')).toHaveCount(
    3,
  );
  await expect(restoredPanel.getByRole('textbox')).toHaveValue('Analyze files');
  await restoredPanel
    .getByRole('button', { name: '发送', exact: true })
    .click();
  await expect(
    restoredPanel.getByRole('heading', { name: 'File analysis' }),
  ).toBeVisible();
  await expect(restoredPanel.getByRole('table')).toBeVisible();
  await expect(restoredPanel.locator('pre code')).toContainText('Friday');
  const fileRequest = requests.at(-1);
  assert.ok(!JSON.stringify(fileRequest.messages).includes('Current revision'));
  assert.ok(
    !JSON.stringify(fileRequest.messages).includes(
      'The project deadline is Friday.',
    ),
  );
  assert.ok(!JSON.stringify(fileRequest.messages).includes('Hello world.'));
  assert.ok(JSON.stringify(fileRequest.messages).includes(notes));
  assert.ok(JSON.stringify(fileRequest.messages).includes(source));
  assert.ok(
    fileRequest.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === 'image_url' &&
            part.image_url.url.startsWith('data:image/png;base64,'),
        ),
    ),
  );
  const modelBox = await restoredPanel
    .getByRole('combobox', { name: 'AI 服务' })
    .boundingBox();
  const sendBox = await restoredPanel
    .getByRole('button', { name: '发送', exact: true })
    .boundingBox();
  assert.ok(modelBox.x + modelBox.width <= sendBox.x);
  assert.ok(Math.abs(modelBox.y - sendBox.y) < 5);
  await page.screenshot({ path: path.join(directory, 'assistant-chat.png') });
  console.log(
    '✓ Markdown, file picker, path-only files and image attachments, independent context, outside dismissal, draft retention and drag resizing',
  );
  await restoredPanel
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  const unsupported = await page.evaluate(async () =>
    window.ipc.invoke('assistant:attachments', {
      paths: ['/not-an-attachment.pdf'],
    }),
  );
  assert.equal(unsupported.attachments.length, 0);
  await restoredPanel.locator('input[type=file]').setInputFiles(source);
  await expect(restoredPanel.getByTestId('assistant-attachment')).toHaveCount(
    1,
  );
  const firstReadRequest = requests.length;
  await restoredPanel.getByRole('textbox').fill('Read attached subtitles');
  await restoredPanel
    .getByRole('button', { name: '发送', exact: true })
    .click();
  await expect(restoredPanel).toContainText('Subtitles inspected through MCP.');
  assert.ok(
    !JSON.stringify(requests[firstReadRequest].messages).includes(
      'Hello world.',
    ),
  );
  assert.ok(
    requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === 'tool' && message.content?.includes('Hello world.'),
      ),
  );
  console.log(
    '✓ subtitle attachment sends only its path, then reads content through the real MCP operation',
  );
  console.log(`Assistant E2E passed. Artifacts: ${directory}`);
  assert.deepEqual(pageErrors, []);
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: path.join(directory, 'failure.png') })
      .catch(() => {});
    console.error(
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(-5500),
    );
  }
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
