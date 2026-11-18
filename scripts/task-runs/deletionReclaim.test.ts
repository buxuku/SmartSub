import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  draftKeyPaths,
  reclaimDeletedDrafts,
} from '../../main/helpers/taskRuns/deletionReclaim';

const root = path.resolve('/smartsub-test');
const at = (...parts: string[]) => path.join(root, ...parts);
const keyOf = (...parts: string[]) =>
  `smartsub_proofread_draft_v1:${JSON.stringify(parts)}`;

function fakeStore(keys: string[]) {
  const entries = new Set(keys);
  return {
    entries,
    list: () => [...entries],
    remove: (key: string) => void entries.delete(key),
  };
}

/** The claim test that a remaining record would provide. */
const nobody = async () => () => false;
const claims =
  (...files: string[]) =>
  async () =>
  (target: string) =>
    files.includes(target);

const storage = at('task-runs', 'abc');
const sidecar = at('proofread-data', 'sidecar.json');

test('draft keys are understood only in the shape the editor writes', () => {
  assert.deepEqual(draftKeyPaths(keyOf(at('a.json'), at('b.srt'), '')), [
    at('a.json'),
    at('b.srt'),
  ]);
  assert.deepEqual(draftKeyPaths(keyOf('', '', '')), []);
  for (const key of [
    'not-a-key',
    'smartsub_proofread_draft_v1:',
    'smartsub_proofread_draft_v1:{"a":1}',
    'smartsub_proofread_draft_v1:[1,"x"]',
    keyOf('relative/path.srt'),
    keyOf(at('a.srt'), 'relative/path.srt'),
  ])
    assert.equal(draftKeyPaths(key), null, key);
});

test('a draft of a reclaimed sidecar goes, whatever else it names, without asking who else uses files', async () => {
  const shared = at('media', 'shared.srt');
  const store = fakeStore([keyOf(sidecar, shared, '')]);
  let asked = 0;
  const report = await reclaimDeletedDrafts(
    [store],
    { sidecars: [sidecar], directories: [] },
    async () => {
      asked += 1;
      return () => true;
    },
  );
  assert.equal(report.removed, 1);
  assert.deepEqual([...store.entries], []);
  assert.equal(asked, 0, 'nothing needed the other records');
});

test('a draft naming files inside deleted storage goes unless a remaining record uses one', async () => {
  const unused = at('task-runs', 'abc', 'files', 'out.srt');
  const used = at('task-runs', 'abc', 'files', 'shared.srt');
  const reviewKey = keyOf('', unused, '');
  const drafts = fakeStore([keyOf('', unused, ''), keyOf('', used, unused)]);
  const reviews = fakeStore([reviewKey]);
  const report = await reclaimDeletedDrafts(
    [drafts, reviews],
    { sidecars: [], directories: [storage] },
    claims(used),
  );
  assert.equal(report.removed, 2, 'one draft and one review');
  assert.deepEqual(
    [...drafts.entries],
    [keyOf('', used, unused)],
    'the document another record still uses keeps its draft',
  );
  assert.deepEqual([...reviews.entries], []);
  assert.deepEqual(report.errors, []);
});

test('only the claim test of the remaining records is consulted, once, and only when needed', async () => {
  let asked = 0;
  const store = fakeStore([
    keyOf('', at('task-runs', 'abc', 'a.srt'), ''),
    keyOf('', at('task-runs', 'abc', 'b.srt'), ''),
  ]);
  await reclaimDeletedDrafts(
    [store],
    { sidecars: [], directories: [storage] },
    async () => {
      asked += 1;
      return () => false;
    },
  );
  assert.equal(asked, 1);
  assert.deepEqual([...store.entries], []);
});

test('entries that do not describe deleted data are kept', async () => {
  const keep = [
    // the user's own files, and a sidecar that stays next to the user's media
    keyOf('', at('videos', 'movie.srt'), ''),
    keyOf(
      at('videos', '.smartsub-proofread', 'x.json'),
      at('videos', 'a.srt'),
      '',
    ),
    // another task's storage and sidecar
    keyOf(
      at('proofread-data', 'other.json'),
      at('task-runs', 'other', 'a.srt'),
      '',
    ),
    // the deleted storage directory itself and a path that merely shares its prefix
    keyOf('', storage, ''),
    keyOf('', `${storage}-copy${path.sep}a.srt`, ''),
    // identities that cannot be read
    'smartsub_proofread_draft_v1:{"broken"',
    'someone-elses-key',
  ];
  const store = fakeStore(keep);
  const report = await reclaimDeletedDrafts(
    [store],
    { sidecars: [sidecar], directories: [storage] },
    nobody,
  );
  assert.equal(report.removed, 0);
  assert.deepEqual([...store.entries], keep);
});

test('nothing is read when the deleted tasks left no sidecar and no storage', async () => {
  let listed = 0;
  const report = await reclaimDeletedDrafts(
    [
      {
        list: () => {
          listed += 1;
          return [];
        },
        remove: () => {},
      },
    ],
    { sidecars: [], directories: [] },
    nobody,
  );
  assert.equal(listed, 0);
  assert.deepEqual(report, { removed: 0, errors: [] });
});

test('one failing entry or store does not stop the others, and is reported', async () => {
  const bad = keyOf(sidecar, '', '');
  const good = keyOf(sidecar, at('x.srt'), '');
  const stuck = fakeStore([bad, good]);
  const failingRemove = stuck.remove;
  stuck.remove = (key: string) => {
    if (key === bad) throw new Error('EBUSY: bad');
    failingRemove(key);
  };
  const unreadable = {
    list: () => {
      throw new Error('EACCES: list');
    },
    remove: () => {},
  };
  const healthy = fakeStore([keyOf(sidecar, at('y.srt'), '')]);
  const report = await reclaimDeletedDrafts(
    [unreadable, stuck, healthy],
    { sidecars: [sidecar], directories: [] },
    nobody,
  );
  assert.equal(report.removed, 2);
  assert.deepEqual([...stuck.entries], [bad]);
  assert.deepEqual([...healthy.entries], []);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.some((message) => /EACCES: list/.test(message)));
  assert.ok(report.errors.some((message) => /EBUSY: bad/.test(message)));
});

test('a failure to collect the references removes nothing that needed them', async () => {
  const inside = keyOf('', at('task-runs', 'abc', 'a.srt'), '');
  const store = fakeStore([inside]);
  const report = await reclaimDeletedDrafts(
    [store],
    { sidecars: [], directories: [storage] },
    async () => {
      throw new Error('TASK_DRAFT_IDENTITY_UNKNOWN');
    },
  );
  assert.equal(report.removed, 0);
  assert.deepEqual([...store.entries], [inside]);
  assert.deepEqual(report.errors, ['Error: TASK_DRAFT_IDENTITY_UNKNOWN']);
});

test('drafts saved or discarded while the references are collected are judged as they are now', async () => {
  const before = keyOf('', at('task-runs', 'abc', 'before.srt'), '');
  const during = keyOf('', at('task-runs', 'abc', 'during.srt'), '');
  const store = fakeStore([before]);
  const report = await reclaimDeletedDrafts(
    [store],
    { sidecars: [], directories: [storage] },
    async () => {
      store.entries.delete(before);
      store.entries.add(during);
      return () => false;
    },
  );
  assert.equal(report.removed, 1);
  assert.deepEqual([...store.entries], []);
  assert.deepEqual(report.errors, []);
});
