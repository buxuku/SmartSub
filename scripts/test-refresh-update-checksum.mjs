import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fingerprint, refreshYaml } from './refresh-update-checksum.mjs';

const script = fileURLToPath(
  new URL('./refresh-update-checksum.mjs', import.meta.url),
);

// 形状与已发布的 v3.10.1 latest.yml 完全一致：只有 url + sha512，没有 size
const PUBLISHED = `version: 3.10.1
files:
  - url: SmartSub_Windows_3.10.1_x64.exe
    sha512: u++eC3VuvAVUcriHkA83Qvg3g0bbGGheOgT+MwoB3Kjob/KkU1q/O5xnVbQNY3fmrThxMs2U9z+sq/GREo37PA==
path: latest.yml
releaseDate: '2026-10-16T04:55:44.310Z'
`;
const OLD = {
  sha512:
    'u++eC3VuvAVUcriHkA83Qvg3g0bbGGheOgT+MwoB3Kjob/KkU1q/O5xnVbQNY3fmrThxMs2U9z+sq/GREo37PA==',
  size: 113037009,
};
const NEW = {
  sha512:
    'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYg==',
  size: 113045528,
};

async function withTempDir(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'refresh-checksum-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('fingerprint matches the standard SHA-512 test vector for "abc"', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'abc.bin');
    writeFileSync(file, 'abc');
    const { sha512, size } = await fingerprint(file);
    assert.equal(
      sha512,
      '3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==',
    );
    assert.equal(size, 3);
  });
});

test('replaces the digest and keeps every other line untouched', () => {
  const { text, digestReplacements, sizeReplacements } = refreshYaml(
    PUBLISHED,
    OLD,
    NEW,
  );
  assert.equal(digestReplacements, 1);
  assert.equal(sizeReplacements, 0);
  assert.equal(text, PUBLISHED.replace(OLD.sha512, NEW.sha512));
  assert.ok(!text.includes(OLD.sha512));
});

test('replaces a top-level sha512 as well as files[].sha512', () => {
  const yml = `version: 1.0.0
files:
  - url: a.exe
    sha512: ${OLD.sha512}
path: a.exe
sha512: ${OLD.sha512}
`;
  const { text, digestReplacements } = refreshYaml(yml, OLD, NEW);
  assert.equal(digestReplacements, 2);
  assert.ok(!text.includes(OLD.sha512));
});

test('updates a matching size field and leaves other sizes alone', () => {
  const yml = `files:
  - url: a.exe
    sha512: ${OLD.sha512}
    size: ${OLD.size}
  - url: other.exe
    sha512: someotherdigest
    size: 42
`;
  const { text, sizeReplacements } = refreshYaml(yml, OLD, NEW);
  assert.equal(sizeReplacements, 1);
  assert.match(text, new RegExp(`size: ${NEW.size}\\n`));
  assert.match(text, /size: 42\n/);
  assert.ok(!text.includes(String(OLD.size)));
});

test('refuses a yml that does not contain the unsigned digest', () => {
  assert.throws(
    () => refreshYaml('version: 1.0.0\nfiles: []\n', OLD, NEW),
    /does not contain the sha512/,
  );
});

test('refuses when signing did not change the installer', () => {
  assert.throws(
    () => refreshYaml(PUBLISHED, OLD, { ...OLD }),
    /byte-identical/,
  );
});

test('CLI rewrites latest.yml from real files', async () => {
  await withTempDir(async (dir) => {
    const unsigned = path.join(dir, 'unsigned.exe');
    const signed = path.join(dir, 'signed.exe');
    const yml = path.join(dir, 'latest.yml');
    writeFileSync(unsigned, 'installer-bytes');
    writeFileSync(signed, 'installer-bytes + authenticode signature');

    const before = await fingerprint(unsigned);
    writeFileSync(
      yml,
      `files:\n  - url: a.exe\n    sha512: ${before.sha512}\n`,
    );

    const run = runCli([
      '--yml',
      yml,
      '--unsigned',
      unsigned,
      '--signed',
      signed,
    ]);
    assert.equal(run.status, 0, run.stderr);

    const after = await fingerprint(signed);
    assert.equal(
      readFileSync(yml, 'utf8'),
      `files:\n  - url: a.exe\n    sha512: ${after.sha512}\n`,
    );
  });
});

test('CLI exits non-zero and leaves the yml alone on a digest mismatch', async () => {
  await withTempDir(async (dir) => {
    const unsigned = path.join(dir, 'unsigned.exe');
    const signed = path.join(dir, 'signed.exe');
    const yml = path.join(dir, 'latest.yml');
    writeFileSync(unsigned, 'one');
    writeFileSync(signed, 'two');
    writeFileSync(yml, PUBLISHED);

    const run = runCli([
      '--yml',
      yml,
      '--unsigned',
      unsigned,
      '--signed',
      signed,
    ]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /does not contain the sha512/);
    assert.equal(readFileSync(yml, 'utf8'), PUBLISHED);
  });
});

test('CLI exits non-zero when latest.yml is missing', async () => {
  await withTempDir(async (dir) => {
    const unsigned = path.join(dir, 'unsigned.exe');
    const signed = path.join(dir, 'signed.exe');
    writeFileSync(unsigned, 'one');
    writeFileSync(signed, 'two');

    const run = runCli([
      '--yml',
      path.join(dir, 'missing.yml'),
      '--unsigned',
      unsigned,
      '--signed',
      signed,
    ]);
    assert.notEqual(run.status, 0);
  });
});

test('CLI rejects missing arguments', () => {
  const run = runCli(['--yml', 'latest.yml']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Usage:/);
});
