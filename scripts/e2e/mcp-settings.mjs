import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { waitForAppPage, appOrigin } from './app-page.mjs';

const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-mcp-settings-'),
);
const profile = path.join(directory, '测试 profile');
const env = { ...process.env, NODE_ENV: 'production' };
delete env.ELECTRON_RUN_AS_NODE;
let app, client, transport, clipboard;
try {
  app = await _electron.launch({
    args: ['.', `--automation-data-dir=${profile}`],
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    ),
  );
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.goto(`${appOrigin(page)}/zh/settings`);
  const card = page.getByTestId('mcp-connection-card');
  await card.scrollIntoViewIfNeeded();
  await expect(
    card.getByRole('button', { name: '一键导入 Cursor' }),
  ).toBeVisible();
  clipboard = await app.evaluate(({ clipboard }) => ({
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
  }));
  // Verify the exact OS handoff without launching Cursor or modifying its settings.
  await app.evaluate(({ shell }) => {
    globalThis.mcpInstallRequests = [];
    shell.openExternal = async (url) => {
      globalThis.mcpInstallRequests.push(url);
    };
  });
  await card.getByRole('button', { name: '一键导入 Cursor' }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.mcpInstallRequests.length))
    .toBe(1);
  const link = new URL(
    await app.evaluate(() => globalThis.mcpInstallRequests[0]),
  );
  const installed = JSON.parse(
    Buffer.from(link.searchParams.get('config'), 'base64').toString('utf8'),
  );
  assert.equal(link.protocol, 'cursor:');
  assert.equal(installed.args.at(-1), profile);
  await card.getByRole('button', { name: '复制配置' }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('mcpServers');
  const copied = JSON.parse(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
  );
  assert.deepEqual(copied.mcpServers.smartsub, installed);
  await card.getByRole('tab', { name: 'Codex', exact: true }).click();
  await card.getByRole('button', { name: '复制配置' }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('[mcp_servers.smartsub]');
  const toml = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(toml.includes('[mcp_servers.smartsub.env]'));
  assert.ok(toml.includes(JSON.stringify(profile)));
  await card.locator('summary').click();
  await card.screenshot({
    path: path.join(directory, 'mcp-settings-codex.png'),
  });
  await card.getByRole('tab', { name: '其他客户端' }).click();
  await card.getByRole('button', { name: '复制配置' }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('mcpServers');
  // The configuration shown in settings must start the actual bundled MCP server.
  transport = new StdioClientTransport({
    command: installed.command,
    args: installed.args,
    env: { ...process.env, ...installed.env },
    stderr: 'pipe',
  });
  client = new Client({ name: 'settings-config-test', version: '1' });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.length >= 100);
  const info = await client.callTool({
    name: 'smartsub_system_info',
    arguments: {},
  });
  assert.equal(info.isError, undefined);
  assert.equal(info.structuredContent.result.profile, profile);
  await card.getByRole('tab', { name: 'Cursor', exact: true }).click();
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error('Cursor not installed');
    };
  });
  await card.getByRole('button', { name: '一键导入 Cursor' }).click();
  await expect(card.getByRole('alert')).toContainText('无法打开 Cursor');
  await expect(card.getByRole('button', { name: '复制配置' })).toBeEnabled();
  console.log(
    JSON.stringify(
      {
        success: true,
        directory,
        checks: [
          'Cursor deep link handoff and failure',
          'JSON/TOML clipboard content',
          'settings card screenshot',
          'generated config starts MCP and uses current profile',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  if (app && clipboard)
    await app
      .evaluate(
        ({ clipboard }, previous) => clipboard.write(previous),
        clipboard,
      )
      .catch(() => {});
  await app?.close();
}
