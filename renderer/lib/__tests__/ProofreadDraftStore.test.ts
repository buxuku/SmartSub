/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createProofreadDraftStore } from '../../../main/helpers/proofreadDraftStore';

let directory: string;
const key = 'smartsub_proofread_draft_v1:../../project';
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofread-draft-store-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('complete snapshots and cleared tombstones survive a fresh store with safe private paths', () => {
  const store = createProofreadDraftStore(directory);
  expect(store.read(key)).toBeNull();
  store.write(key, '{"version":1}');
  expect(createProofreadDraftStore(directory).read(key)).toBe('{"version":1}');
  store.write(key, '{"version":2}');
  expect(createProofreadDraftStore(directory).read(key)).toBe('{"version":2}');
  const files = fs.readdirSync(directory).sort();
  expect(files).toHaveLength(2);
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  expect(files[1]).toBe(`${files[0]}.key`);
  if (process.platform !== 'win32')
    expect(fs.statSync(path.join(directory, files[0])).mode & 0o777).toBe(
      0o600,
    );
  store.write(key, null);
  expect(createProofreadDraftStore(directory).read(key)).toBe('null');
  expect(() => store.write('../../outside', 'bad')).toThrow('Invalid');
});

test('list reports the entries that can name their own document', () => {
  const store = createProofreadDraftStore(directory);
  expect(store.list()).toEqual([]);
  const tombstone = 'smartsub_proofread_draft_v1:["a","b",""]';
  store.write(key, '{"version":1}');
  store.write(tombstone, null);
  expect(store.list().sort()).toEqual([key, tombstone].sort());
  // Data without an identity, and an identity that does not hash to its own file, say
  // nothing about which document they belong to.
  fs.writeFileSync(path.join(directory, `${'e'.repeat(64)}.json`), '{}');
  fs.writeFileSync(path.join(directory, `${'f'.repeat(64)}.json.key`), key);
  fs.writeFileSync(
    path.join(directory, `${'d'.repeat(64)}.json.key`),
    'not-a-draft-key',
  );
  expect(store.list().sort()).toEqual([key, tombstone].sort());
});

test('remove deletes one entry completely and can be repeated', () => {
  const store = createProofreadDraftStore(directory);
  const other = 'smartsub_proofread_draft_v1:["other"]';
  store.write(key, 'draft');
  store.write(other, 'kept');
  store.remove(key);
  store.remove(key);
  expect(store.read(key)).toBeNull();
  expect(store.list()).toEqual([other]);
  expect(store.read(other)).toBe('kept');
  expect(fs.readdirSync(directory)).toHaveLength(2);
  expect(() => store.remove('../../outside')).toThrow('Invalid');
});

test('a failed remove keeps the identity so that a retry finishes the job', () => {
  const store = createProofreadDraftStore(directory);
  store.write(key, 'draft');
  const unlink = fs.unlinkSync;
  const failure = jest.spyOn(fs, 'unlinkSync').mockImplementation(((
    target: fs.PathLike,
  ) => {
    if (String(target).endsWith('.key'))
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return unlink(target);
  }) as typeof fs.unlinkSync);
  expect(() => store.remove(key)).toThrow('busy');
  failure.mockRestore();
  // The data is already gone, the key is still there to be found again.
  expect(store.read(key)).toBeNull();
  expect(store.list()).toEqual([key]);
  store.remove(key);
  expect(fs.readdirSync(directory)).toEqual([]);
});

test.each(['writeFileSync', 'fsyncSync', 'renameSync'] as const)(
  '%s failure leaves the previous complete draft and cleans temporary files',
  (operation) => {
    const store = createProofreadDraftStore(directory);
    store.write(key, 'previous');
    const failure = jest.spyOn(fs, operation).mockImplementation(() => {
      throw new Error('Disk failure');
    });
    expect(() => store.write(key, 'next')).toThrow('Disk failure');
    expect(() => store.write(key, null)).toThrow('Disk failure');
    failure.mockRestore();
    expect(createProofreadDraftStore(directory).read(key)).toBe('previous');
    const remaining = fs.readdirSync(directory).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(remaining[1]).toBe(`${remaining[0]}.key`);
    store.write(key, 'retry');
    expect(createProofreadDraftStore(directory).read(key)).toBe('retry');
  },
);
