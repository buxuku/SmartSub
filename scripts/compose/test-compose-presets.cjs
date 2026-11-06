const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
const handlers = new Map();
let stored = [];
let failWrite = false;
let queueEvents;
let windows = [];
const clone = (value) => structuredClone(value);
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (request === 'electron')
    return {
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      BrowserWindow: { getAllWindows: () => windows },
    };
  if (parent?.filename.endsWith('/ipcSubtitleMergeHandlers.ts')) {
    if (request === './store')
      return {
        store: {
          get: () => clone(stored),
          set: (_key, value) => {
            if (failWrite) throw new Error('ENOSPC');
            stored = clone(value);
          },
        },
      };
    if (request === './storeManager') return { logMessage() {} };
    if (request === './compose/composeQueue')
      return {
        setComposeEventListeners(value) {
          queueEvents = value;
        },
      };
    if (
      ['./fontResolver', './subtitleMerger', './hwEncoderDetector'].includes(
        request,
      )
    )
      return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
async function main() {
  const {
    setupSubtitleMergeHandlers,
  } = require('../../main/helpers/ipcSubtitleMergeHandlers.ts');
  const {
    DEFAULT_STYLE,
  } = require('../../renderer/components/subtitleMerge/constants.ts');
  const session = {};
  const received = [];
  const window = (name, url, sameSession = true) => ({
    webContents: {
      session: sameSession ? session : {},
      getURL: () => url,
      send: (channel, value) => received.push({ name, channel, value }),
    },
  });
  const mainWindow = window('main', 'app://./zh/home/');
  setupSubtitleMergeHandlers(mainWindow);
  windows = [
    mainWindow,
    window('peer', 'app://./zh/subtitleMerge/'),
    window('external', 'https://example.com/'),
    window('other-profile', 'app://./zh/home/', false),
    {
      webContents: {
        session,
        getURL() {
          throw new Error('Destroyed');
        },
      },
    },
  ];
  queueEvents.onProgress({ percent: 23 });
  queueEvents.onQueueChange([{ id: 'owned' }]);
  assert.deepEqual(
    received.map((event) => [event.name, event.channel]),
    [
      ['main', 'subtitleMerge:progress'],
      ['peer', 'subtitleMerge:progress'],
      ['main', 'compose:queue'],
      ['peer', 'compose:queue'],
    ],
  );
  mainWindow.webContents.getURL = () => {
    throw new Error('Owner closed');
  };
  windows = [windows[1]];
  queueEvents.onQueueChange([{ id: 'surviving-peer' }]);
  assert.equal(received.at(-1).value[0].id, 'surviving-peer');
  const call = (name, payload) =>
    handlers.get(`subtitleMerge:${name}`)({}, payload);
  const payload = {
    id: 'stable-client-id',
    name: 'Retry',
    style: DEFAULT_STYLE,
  };
  const saved = await call('saveStylePreset', payload);
  assert.equal(saved.data.id, payload.id);
  const created = saved.data.createdAt;
  // Discard the first response: replay must upsert, not create another object.
  await call('saveStylePreset', payload);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].createdAt, created);
  await call('saveStylePreset', { ...payload, name: 'Updated' });
  assert.equal(stored[0].name, 'Updated');
  const before = clone(stored);
  failWrite = true;
  await assert.rejects(
    call('saveStylePreset', { ...payload, name: 'Failed' }),
    /ENOSPC/,
  );
  await assert.rejects(call('deleteStylePreset', payload.id), /ENOSPC/);
  assert.deepEqual(stored, before);
  failWrite = false;
  await assert.rejects(
    call('saveStylePreset', {
      ...payload,
      style: { ...DEFAULT_STYLE, primaryColor: '#F' },
    }),
    /Invalid subtitle style/,
  );
  assert.equal(
    (await call('saveStylePreset', { ...payload, id: '' })).success,
    false,
  );
  assert.deepEqual(stored, before);
  assert.equal((await call('deleteStylePreset', payload.id)).data, true);
  assert.equal((await call('deleteStylePreset', payload.id)).data, true);
  assert.equal(stored.length, 0);
  const legacy = await call('saveStylePreset', {
    name: 'Legacy',
    style: DEFAULT_STYLE,
  });
  assert.ok(legacy.data.id);
  stored = { damaged: true };
  await assert.rejects(
    call('listStylePresets'),
    /Invalid saved style preset list/,
  );
  await assert.rejects(
    call('saveStylePreset', payload),
    /Invalid saved style preset list/,
  );
  assert.deepEqual(stored, { damaged: true });
  console.log(
    'Compose preset handlers: stable-id replay, update, failed writes, malformed style/id, idempotent delete, legacy ids and corrupt-list preservation passed.',
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
  });
