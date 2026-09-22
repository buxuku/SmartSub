const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness(directory) {
  const cache = new Map();
  let failure;
  const logs = [];
  const disk = {
    ...fsp,
    async rename(from, to) {
      if (failure && to.endsWith('configurations.json'))
        throw new Error(failure);
      return fsp.rename(from, to);
    },
  };
  const load = (filename) => {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    vm.runInNewContext(
      source,
      {
        module,
        exports: module.exports,
        structuredClone,
        process,
        console: Object.fromEntries(
          ['log', 'warn', 'error'].map((key) => [
            key,
            (...args) => logs.push(args),
          ]),
        ),
        require(request) {
          if (request === 'electron')
            return {
              app: { getPath: () => directory },
              ipcMain: { handle() {} },
            };
          if (request === 'fs/promises') return disk;
          if (request.startsWith('.'))
            return load(path.resolve(path.dirname(filename), `${request}.ts`));
          return require(request);
        },
      },
      { filename },
    );
    return module.exports;
  };
  return {
    manager: load(
      path.resolve(__dirname, '../main/service/configurationManager.ts'),
    ).configurationManager,
    fail: (value) => {
      failure = value;
    },
    logs,
  };
}

const config = (value) => ({
  headerParameters: { 'X-Custom': 'fixture-header-content' },
  bodyParameters: { temperature: value },
  configVersion: '1.2.0',
  lastModified: 1,
});
(async () => {
  const directory = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-parameter-unit-'),
  );
  const file = path.join(directory, 'parameter-configs/configurations.json');
  const test = harness(directory);
  const manager = test.manager;
  await Promise.all([manager.initialize(), manager.initialize()]);
  await manager.saveConfiguration('a', config(0.1));
  const original = await fsp.readFile(file, 'utf8');
  test.fail('ENOSPC');
  await assert.rejects(manager.saveConfiguration('a', config(0.2)), /ENOSPC/);
  assert.equal(
    (await manager.getConfiguration('a')).bodyParameters.temperature,
    0.1,
  );
  assert.equal(await fsp.readFile(file, 'utf8'), original);
  await assert.rejects(manager.deleteConfiguration('a'), /ENOSPC/);
  assert.ok(await manager.getConfiguration('a'));
  const imported = await manager.importConfigurations({
    configurations: {
      b: { config: config(0.3), metadata: { version: '1.2.0' } },
    },
    exportedAt: '',
    version: '1.0.0',
  });
  assert.equal(imported.imported, 0);
  assert.equal(imported.errors.length, 1);
  assert.equal(await manager.getConfiguration('b'), null);
  test.fail(null);
  await Promise.all([
    manager.saveConfiguration('a', config(0.4)),
    manager.saveConfiguration('b', config(0.5)),
    manager.saveConfiguration('a', config(0.6)),
  ]);
  const persisted = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(persisted.a.config.bodyParameters.temperature, 0.6);
  assert.equal(persisted.b.config.bodyParameters.temperature, 0.5);
  const copy = await manager.getConfiguration('a');
  copy.bodyParameters.temperature = 99;
  assert.equal(
    (await manager.getConfiguration('a')).bodyParameters.temperature,
    0.6,
  );
  assert.equal(await manager.deleteConfiguration('missing'), true);
  const restored = harness(directory).manager;
  assert.equal(
    (await restored.getConfiguration('a')).bodyParameters.temperature,
    0.6,
  );
  const backups = await manager.listProviderBackups('a');
  assert.ok(backups.length);
  test.fail('EACCES');
  assert.equal(
    (await manager.restoreFromBackup('a', backups[0].fileName)).success,
    false,
  );
  assert.equal(
    (await manager.getConfiguration('a')).bodyParameters.temperature,
    0.6,
  );
  test.fail(null);
  const badHeader = { ...config(0.1), headerParameters: { 'X-Count': 3 } };
  await assert.rejects(
    manager.saveConfiguration('a', badHeader),
    /validation/i,
  );
  const validation = await manager.validateConfiguration(badHeader);
  assert.equal(validation.isValid, false);
  assert.ok(validation.errors.some((error) => error.key === 'X-Count'));
  await manager.saveConfiguration('headers', {
    ...config(0.3),
    headerParameters: {
      Authorization: 'Bearer ${API_KEY}',
      'X-Custom-Auth': '${API_KEY}',
      'Content-Type': 'application/json',
    },
    bodyParameters: { max_tokens: 300, custom_field: 'private test keyword' },
  });
  await assert.rejects(
    manager.saveConfiguration('headers', {
      ...config(0.3),
      headerParameters: { 'X-Custom': 'one\r\ntwo' },
    }),
    /control characters/,
  );
  await assert.rejects(
    manager.saveConfiguration('headers', {
      ...config(0.3),
      bodyParameters: { temperature: Infinity },
    }),
    /finite/,
  );
  assert.ok(
    !JSON.stringify(test.logs).includes('fixture-header-content'),
    'parameter values must not be logged',
  );
  await fsp.writeFile(file, '{corrupt');
  const corrupt = harness(directory).manager;
  await assert.rejects(corrupt.getConfiguration('a'));
  await assert.rejects(corrupt.saveConfiguration('a', config(1)));
  assert.equal(await fsp.readFile(file, 'utf8'), '{corrupt');
  await fsp.writeFile(
    file,
    JSON.stringify({
      legacy: {
        config: { headerConfigs: {}, bodyConfigs: { temperature: 0.8 } },
        metadata: { version: '0.9.0' },
      },
    }),
  );
  const migrated = await harness(directory).manager.getConfiguration('legacy');
  assert.equal(migrated.configVersion, '1.2.0');
  assert.equal(migrated.bodyParameters.temperature, 0.8);
  console.log(
    'Parameter persistence: atomic failure, retry, concurrency, reset, import, restore, isolation, validation, corrupt read and migration passed.',
  );
  console.log(`Evidence: ${directory}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
