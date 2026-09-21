const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
const handlers = new Map();
let values = [];
let writes = 0;
let failWrite = false;
let context;
const projects = new Map([
  ['a', { id: 'a', name: 'Same'.repeat(50) }],
  ['b', { id: 'b', name: 'Same'.repeat(50) }],
]);
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (request === 'electron')
    return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  if (request.endsWith('/storeManager'))
    return {
      logMessage() {},
      store: {
        get: (key) => (key === 'glossaries' ? values : { language: 'en' }),
        set: (key, value) => {
          assert.equal(key, 'glossaries');
          if (failWrite) throw new Error('Disk full');
          writes++;
          values = structuredClone(value);
        },
      },
    };
  if (request.endsWith('/workItemStore'))
    return { getWorkItemById: (id) => projects.get(id) };
  if (request.endsWith('/taskContext'))
    return { getTaskContext: () => context };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const manager = require('../main/helpers/glossaryManager.ts');
  require('../main/helpers/ipcGlossaryHandlers.ts').setupGlossaryHandlers({});
  const save = (extra = {}) =>
    handlers.get('glossaries:add-context-entry')(
      {},
      { source: 'Alice', target: 'Global Alice', scope: 'global', ...extra },
    );
  failWrite = true;
  assert.deepEqual(save(), { success: false, error: 'Disk full' });
  assert.equal(values.length, 0, 'failed creation leaves no empty collection');
  failWrite = false;
  const first = save();
  assert.equal(first.success, true);
  assert.equal(writes, 1, 'collection and entry use one write');
  assert.equal(first.data.glossary.name, 'Proofread terms');
  assert.equal(save().data.entry.id, first.data.entry.id);
  assert.equal(writes, 1, 'idempotent save does not write');
  const conflict = save({ target: 'Replacement' });
  assert.equal(conflict.error, 'ENTRY_CONFLICT');
  assert.equal(writes, 1);
  assert.equal(
    save({ target: 'Replacement', expectedTarget: 'Stale' }).error,
    'ENTRY_CONFLICT',
  );
  failWrite = true;
  assert.equal(
    save({ target: 'Replacement', expectedTarget: 'Global Alice' }).success,
    false,
  );
  assert.equal(
    values[0].entries[0].target,
    'Global Alice',
    'failed overwrite cannot mutate stored snapshot',
  );
  failWrite = false;
  const changed = save({
    target: 'Replacement',
    expectedTarget: 'Global Alice',
  });
  assert.equal(changed.success, true);
  assert.equal(changed.data.entry.id, first.data.entry.id);
  assert.equal(save({ scope: 'project' }).error, 'PROJECT_NOT_FOUND');
  assert.equal(
    save({ scope: 'project', projectId: 'missing' }).error,
    'PROJECT_NOT_FOUND',
  );
  assert.equal(save({ scope: 'invalid' }).error, 'INVALID_SCOPE');
  assert.equal(save({ source: 'x'.repeat(301) }).error, 'ENTRY_TOO_LONG');
  assert.equal(save({ target: '' }).error, 'ENTRY_TARGET_REQUIRED');
  const a = save({ scope: 'project', projectId: 'a', target: 'A Alice' });
  const b = save({ scope: 'project', projectId: 'b', target: 'B Alice' });
  assert.equal(a.success && b.success, true);
  assert.ok(
    a.data.glossary.name.length <= 80 && b.data.glossary.name.length <= 80,
  );
  assert.notEqual(a.data.glossary.name, b.data.glossary.name);
  assert.equal(new Set(values.map((g) => g.name)).size, values.length);
  assert.deepEqual(
    manager.getActiveGlossaryResolution().entries.map((e) => e.target),
    ['Replacement'],
  );
  context = { projectId: 'a' };
  assert.deepEqual(
    manager.getActiveGlossaryResolution().entries.map((e) => e.target),
    ['A Alice'],
  );
  assert.deepEqual(
    manager.getActiveGlossaryResolution('b').entries.map((e) => e.target),
    ['B Alice'],
  );
  manager.updateGlossary(a.data.glossary.id, { enabled: false });
  assert.deepEqual(
    manager.getActiveGlossaryResolution().entries.map((e) => e.target),
    ['Replacement'],
  );
  const enabled = save({
    scope: 'project',
    projectId: 'a',
    target: 'A enabled',
  });
  assert.equal(enabled.data.glossary.enabled, true);
  assert.notEqual(
    enabled.data.glossary.id,
    a.data.glossary.id,
    'disabled library stays disabled',
  );
  assert.deepEqual(
    manager.getActiveGlossaryResolution().entries.map((e) => e.target),
    ['A enabled'],
  );
  console.log(
    'Context glossary backend: atomic writes, rollback, CAS, idempotence, scope isolation, task context and bounded unique names passed.',
  );
} finally {
  Module._load = originalLoad;
  require.extensions['.ts'] = originalTs;
}
