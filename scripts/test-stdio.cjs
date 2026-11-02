const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

function compile(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
}

const guard = compile('main/helpers/stdio.ts');
const logStorage = compile('main/helpers/logStorage.ts');

for (const stream of ['stdout', 'stderr']) {
  test(
    `${stream}: a closed reader cannot interrupt work or file logging`,
    { timeout: 15_000 },
    async (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'smartsub-stdio-'),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
          ${guard}
          const storage = { exports: {} };
          new Function('module', 'exports', 'require', ${JSON.stringify(logStorage)})(
            storage, storage.exports,
            (id) => id === 'electron'
              ? { app: { getPath: () => process.argv[2] } }
              : require(id),
          );
          process.once('message', async () => {
            const stream = process[process.argv[1]];
            const errors = [];
            for (let i = 0; i < 2; i++) {
              errors.push(await new Promise((resolve) => {
                stream.write('pipe probe\\n', (error) => resolve(error?.code));
              }));
              await new Promise(setImmediate);
            }
            console.log('work continued');
            console.error('diagnostic output');
            storage.exports.appendLog({
              message: 'task completed after broken pipe',
              type: 'info',
              timestamp: Date.now(),
            });
            await storage.exports.flushLogWrites();
            process.send({ completed: true, errors });
            process.disconnect();
          });
          process.send({ ready: true });
        `,
          stream,
          directory,
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      t.after(() => child.kill());
      const messages = [];
      let diagnostic = '';
      child.on('message', (message) => messages.push(message));
      child[stream === 'stdout' ? 'stderr' : 'stdout'].on('data', (chunk) => {
        diagnostic += chunk;
      });
      const closed = once(child, 'close');
      const timer = setTimeout(() => child.kill(), 10_000);
      t.after(() => clearTimeout(timer));
      await once(child, 'message');
      const readerClosed = once(child[stream], 'close');
      child[stream].destroy();
      await readerClosed;
      child.send('write');
      const [code, signal] = await closed;
      assert.equal(signal, null, diagnostic);
      assert.equal(code, 0, diagnostic);
      assert.deepEqual(messages.at(-1), {
        completed: true,
        errors: ['EPIPE', 'EPIPE'],
      });
      const logs = fs.readdirSync(path.join(directory, 'logs'));
      const entry = JSON.parse(
        fs.readFileSync(path.join(directory, 'logs', logs[0]), 'utf8').trim(),
      );
      assert.equal(entry.message, 'task completed after broken pipe');
      assert.match(diagnostic, /work continued|diagnostic output/);
    },
  );

  test(`${stream}: errors other than EPIPE still escape`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `${guard}\nprocess.${stream}.emit('error', Object.assign(new Error('stdio EIO sentinel'), { code: 'EIO' }));`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stdio EIO sentinel/);
  });
}

test('unrelated stream EPIPE and ordinary exceptions still escape', () => {
  for (const code of [
    `new (require('node:stream').PassThrough)().emit('error', Object.assign(new Error('other pipe sentinel'), { code: 'EPIPE' }));`,
    `throw new Error('ordinary exception sentinel');`,
  ]) {
    const result = spawnSync(process.execPath, ['-e', `${guard}\n${code}`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sentinel/);
  }
});

test('connected stdout and stderr keep their normal output', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', `${guard}\nconsole.log('out'); console.error('err');`],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'err\n');
});
