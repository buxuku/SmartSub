const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-mcp-config-'));
const cache = new Map();
const handlers = new Map();
const calls = [];
const fakeProcess = {
  platform: 'darwin',
  resourcesPath: path.join(root, 'Resources'),
  env: {},
};
const app = {
  isPackaged: true,
  getAppPath: () => root,
  getPath: (key) =>
    key === 'exe'
      ? '/Applications/Smart Sub.app/Contents/MacOS/SmartSub'
      : path.join(root, '用户 profile'),
};
const electron = {
  app,
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: (sender) => sender.owned },
  shell: {
    openExternal: async (url) => {
      calls.push(url);
    },
  },
};
function load(relative) {
  const filename = path.resolve(relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      process: fakeProcess,
      Buffer,
      Error,
      require(request) {
        if (request === 'electron') return electron;
        return request.startsWith('.')
          ? load(path.resolve(path.dirname(filename), `${request}.ts`))
          : require(request);
      },
    },
    { filename },
  );
  return module.exports;
}
const json = (value) => JSON.parse(JSON.stringify(value));
const { createMcpServerConfig, formatMcpConfig, cursorInstallUrl } = load(
  'automation/mcpConfig.ts',
);
const { currentMcpServerConfig, setupMcpConfigHandlers } = load(
  'main/automation/mcpSetup.ts',
);
const packedEntry = path.join(
  fakeProcess.resourcesPath,
  'automation',
  'cli.cjs',
);
const devEntry = path.join(root, 'app', 'automation', 'cli.cjs');
for (const entry of [packedEntry, devEntry]) {
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'bundled client');
}
async function main() {
  for (const executable of [
    '/Applications/Smart Sub.app/Contents/MacOS/SmartSub',
    'C:\\Users\\测试 用户\\SmartSub\\SmartSub.exe',
    '/home/user/a "quoted" app/SmartSub',
  ]) {
    const config = createMcpServerConfig({
      executable,
      entry: '/目录 with spaces/cli.cjs',
      dataDir: '/profile/中文',
    });
    const url = new URL(cursorInstallUrl(config));
    assert.equal(url.protocol, 'cursor:');
    assert.equal(url.hostname, 'anysphere.cursor-deeplink');
    assert.equal(url.pathname, '/mcp/install');
    assert.equal(url.searchParams.get('name'), 'smartsub');
    const decoded = JSON.parse(
      Buffer.from(url.searchParams.get('config'), 'base64').toString('utf8'),
    );
    assert.deepEqual(decoded, json(config));
    assert.equal(decoded.mcpServers, undefined);
    const { toml, json: text } = formatMcpConfig(config);
    assert.deepEqual(JSON.parse(text).mcpServers.smartsub, decoded);
    assert.equal(
      JSON.parse(toml.split('\n')[1].slice('command = '.length)),
      executable,
    );
    assert.ok(toml.includes('[mcp_servers.smartsub.env]'));
    assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(config.env.SMARTSUB_DEV, undefined);
  }
  const packaged = currentMcpServerConfig();
  assert.equal(packaged.args[0], packedEntry);
  assert.equal(packaged.command, app.getPath('exe'));
  assert.deepEqual(json(packaged.args.slice(-2)), [
    '--data-dir',
    app.getPath('userData'),
  ]);
  app.isPackaged = false;
  const dev = currentMcpServerConfig();
  assert.equal(dev.args[0], devEntry);
  assert.equal(dev.env.SMARTSUB_DEV, '1');
  fs.unlinkSync(devEntry);
  assert.throws(() => currentMcpServerConfig(), /MCP_ENTRY_UNAVAILABLE/);
  app.isPackaged = true;
  fakeProcess.platform = 'linux';
  fakeProcess.env.APPIMAGE = '/home/user/Smart Sub.AppImage';
  const image = currentMcpServerConfig();
  assert.equal(image.command, fakeProcess.env.APPIMAGE);
  assert.ok(image.args[0].startsWith(app.getPath('userData')));
  assert.equal(fs.readFileSync(image.args[0], 'utf8'), 'bundled client');
  setupMcpConfigHandlers();
  const sender = { owned: true, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  const preview = handlers.get('mcp:get-config')(event);
  await handlers.get('mcp:install-cursor')(event, 'https://untrusted.test/');
  assert.equal(calls[0], cursorInstallUrl(currentMcpServerConfig()));
  assert.deepEqual(
    JSON.parse(preview.json).mcpServers.smartsub,
    json(currentMcpServerConfig()),
  );
  assert.throws(
    () => handlers.get('mcp:get-config')({ sender, senderFrame: {} }),
    /MCP_SETTINGS_WINDOW_REQUIRED/,
  );
  sender.owned = false;
  assert.throws(
    () => handlers.get('mcp:install-cursor')(event),
    /MCP_SETTINGS_WINDOW_REQUIRED/,
  );
  sender.owned = true;
  electron.shell.openExternal = async () => {
    throw new Error('Cursor unavailable');
  };
  await assert.rejects(
    handlers.get('mcp:install-cursor')(event),
    /Cursor unavailable/,
  );
  console.log(
    'MCP config: Cursor UTF-8 deep links, JSON/TOML paths, packaged/dev/AppImage entries, profile binding, IPC scope and launch failure passed.',
  );
}
main()
  .finally(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
