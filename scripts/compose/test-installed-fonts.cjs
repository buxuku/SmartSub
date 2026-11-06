const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'smartsub-installed-fonts-'),
);
const sandboxFs = { ...fs };
const fontDirectory =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Fonts')
    : process.platform === 'win32'
      ? path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'),
          'Microsoft/Windows/Fonts',
        )
      : path.join(os.homedir(), '.fonts');
const map = (file) =>
  file === fontDirectory
    ? root
    : file.startsWith(fontDirectory + path.sep)
      ? path.join(root, file.slice(fontDirectory.length + 1))
      : file;
for (const method of ['statSync', 'existsSync', 'readFileSync'])
  sandboxFs[method] = (file, ...args) => fs[method](map(file), ...args);
sandboxFs.readdirSync = (file, ...args) =>
  fs.readdirSync(
    file === fontDirectory ? root : path.join(root, 'empty'),
    ...args,
  );
sandboxFs.promises = {
  ...fs.promises,
  readdir: async (file, ...args) => sandboxFs.readdirSync(file, ...args),
  stat: async (file) => sandboxFs.statSync(file),
  readFile: async (file) => sandboxFs.readFileSync(file),
};
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
  if (parent?.filename.endsWith('/fontResolver.ts')) {
    if (request === 'fs') return sandboxFs;
    if (request === 'fontkit') {
      const kit = originalLoad.call(this, request, parent, isMain);
      return { ...kit, openSync: (file) => kit.openSync(map(file)) };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
async function main() {
  const { embeddedFontFixture } = await import('./embedded-font-fixture.mjs');
  fs.writeFileSync(path.join(root, 'installed.ttf'), embeddedFontFixture());
  fs.writeFileSync(path.join(root, 'broken.ttf'), Buffer.from([1, 2, 3]));
  const fonts = require('../../main/helpers/fontResolver.ts');
  await fonts.prepareSubtitleFonts();
  assert.equal(fonts.isFontAvailable('codicon'), true);
  assert.equal(fonts.resolveBurnFontName('codicon', false), 'codicon');
  assert.deepEqual(fonts.loadFontData('codicon').data, embeddedFontFixture());
  assert.equal(
    (await fonts.listSubtitleFonts()).find((font) => font.name === 'codicon')
      .available,
    true,
  );
  assert.deepEqual(fonts.fontTextRuns('\uea60', 'codicon'), [
    { fontName: 'codicon', text: '\uea60' },
  ]);
  fs.writeFileSync(path.join(root, 'installed.ttf'), Buffer.from([1, 2, 3]));
  assert.equal(fonts.isFontAvailable('codicon'), false);
  await fonts.prepareSubtitleFonts(true);
  assert.equal(
    (await fonts.listSubtitleFonts()).some((font) => font.name === 'codicon'),
    false,
    'refresh drops aliases and family metadata of corrupted fonts',
  );
  fs.writeFileSync(path.join(root, 'installed.ttf'), embeddedFontFixture());
  await fonts.prepareSubtitleFonts(true);
  assert.equal(fonts.isFontAvailable('codicon'), true);
  assert.deepEqual(fonts.loadFontData('codicon').data, embeddedFontFixture());
  const temporary = path.join(root, 'installed.ttf');
  fs.renameSync(temporary, path.join(root, 'removed.ttf.fixture'));
  assert.equal(
    fonts.isFontAvailable('codicon'),
    false,
    'uninstalled cached font must not remain available',
  );
  assert.equal(
    (await fonts.listSubtitleFonts()).find((font) => font.name === 'codicon')
      .available,
    false,
  );
  for (let index = 0; index < 1200; index++)
    fs.linkSync(
      path.join(root, 'removed.ttf.fixture'),
      path.join(root, `large-${index}.ttf`),
    );
  let reads = 0;
  const read = sandboxFs.promises.readFile;
  sandboxFs.promises.readFile = (...args) => {
    reads++;
    return read(...args);
  };
  let ticks = 0,
    last = performance.now(),
    maxDelay = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxDelay = Math.max(maxDelay, now - last);
    last = now;
    ticks++;
  }, 5);
  const started = performance.now();
  try {
    await Promise.all([
      fonts.prepareSubtitleFonts(true),
      fonts.prepareSubtitleFonts(true),
      fonts.listSubtitleFonts(),
    ]);
  } finally {
    clearInterval(heartbeat);
  }
  const elapsed = performance.now() - started;
  assert.equal(
    reads,
    1201,
    'concurrent scan coalesces; only changed fonts and corrupt neighbor read',
  );
  assert.ok(ticks > 5, `main event loop must stay live: ticks=${ticks}`);
  assert.ok(maxDelay < 200, `scan blocked main event loop: ${maxDelay}ms`);
  const beforeList = reads;
  await fonts.listSubtitleFonts();
  assert.equal(
    reads,
    beforeList,
    'cached menu does not parse every font again',
  );
  fs.renameSync(path.join(root, 'large-0.ttf'), path.join(root, 'renamed.ttf'));
  await fonts.prepareSubtitleFonts(true);
  assert.equal(fonts.isFontAvailable('codicon'), true);
  console.log(
    JSON.stringify({
      root,
      files: 1200,
      elapsedMs: elapsed,
      heartbeatTicks: ticks,
      maxDelayMs: maxDelay,
      checks:
        'actual TTF in isolated user font directory, corrupt neighbor, in-place corruption/repair refresh, binary loading, glyph lookup, removal invalidation, coalesced responsive 1200-file scan',
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    if (originalTs) require.extensions['.ts'] = originalTs;
    else delete require.extensions['.ts'];
  });
