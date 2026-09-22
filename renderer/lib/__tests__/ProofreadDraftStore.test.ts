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
  const files = fs.readdirSync(directory);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  if (process.platform !== 'win32')
    expect(fs.statSync(path.join(directory, files[0])).mode & 0o777).toBe(
      0o600,
    );
  store.write(key, null);
  expect(createProofreadDraftStore(directory).read(key)).toBe('null');
  expect(() => store.write('../../outside', 'bad')).toThrow('Invalid');
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
    expect(fs.readdirSync(directory)).toHaveLength(1);
    store.write(key, 'retry');
    expect(createProofreadDraftStore(directory).read(key)).toBe('retry');
  },
);
