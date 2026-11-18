import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  draftKeyPaths,
  intermediateSubtitles,
  reclaimDeletedDrafts,
  reclaimIntermediateSubtitles,
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

const uuid = '3f2b8c1e-9a4d-4e7b-8c55-0d1f6a7b9c21';
const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
const temp = at('temp');
const record = (file: Record<string, unknown>) =>
  ({ id: 'task', pipelineFiles: [file] }) as any;

test('intermediate subtitles are the cached files recorded in a shared temp directory', () => {
  const recorded = {
    tempTranslatedSrtFile: path.join(temp, `${uuid}.srt`),
    tempSrtFile: path.join(temp, `${md5}-source.srt`),
    tempFinalSubtitleFile: path.join(temp, `${md5}-final.srt`),
  };
  assert.deepEqual(
    intermediateSubtitles([record(recorded), record(recorded)], [temp]),
    Object.values(recorded),
    'each file once, in field order',
  );
  const otherTemp = at('default-temp');
  assert.deepEqual(
    intermediateSubtitles(
      [record({ tempSrtFile: path.join(otherTemp, `${uuid}.srt`) })],
      [temp, otherTemp],
    ),
    [path.join(otherTemp, `${uuid}.srt`)],
    'the default temp directory counts as well',
  );
});

test('subtitles that are published, nested, renamed or elsewhere are not intermediate', () => {
  const notCandidates = [
    { tempSrtFile: at('videos', 'movie.srt') },
    { tempSrtFile: path.join(temp, 'notes.srt') },
    { tempSrtFile: path.join(temp, 'sub', `${uuid}.srt`) },
    { tempSrtFile: path.join(at('elsewhere'), `${uuid}.srt`) },
    { tempSrtFile: path.join(`${temp}-copy`, `${uuid}.srt`) },
    { tempTranslatedSrtFile: `${uuid}.srt` },
    { tempTranslatedSrtFile: path.join(temp, `${uuid}.srt`.toUpperCase()) },
    { tempFinalSubtitleFile: path.join(temp, `${md5}-draft.srt`) },
    { tempFinalSubtitleFile: path.join(temp, `${uuid}.vtt`) },
    { tempFinalSubtitleFile: path.join(temp, `${md5}.srt`) },
    // named like a cache file, but recorded in a field that is not a cache field
    { srtFile: path.join(temp, `${uuid}.srt`) },
    { translatedSrtFile: path.join(temp, `${md5}-final.srt`) },
    { tempSrtFile: 42 },
    null,
  ];
  for (const file of notCandidates)
    assert.deepEqual(
      intermediateSubtitles([record(file as any)], [temp]),
      [],
      JSON.stringify(file),
    );
  assert.deepEqual(
    intermediateSubtitles(
      [{ id: 'a' }, { id: 'b', pipelineFiles: 'nope' }] as any,
      [temp],
    ),
    [],
  );
  // a relative path would be resolved against the working directory: never a candidate
  assert.deepEqual(
    intermediateSubtitles(
      [record({ tempTranslatedSrtFile: `${uuid}.srt` })],
      [process.cwd()],
    ),
    [],
  );
});

function tempFolder(t: any) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediate-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test('unreferenced intermediate subtitles are deleted and referenced ones are kept', async (t) => {
  const folder = tempFolder(t);
  const gone = path.join(folder, `${uuid}.srt`);
  const kept = path.join(folder, `${md5}-source.srt`);
  const missing = path.join(folder, `${md5}-final.srt`);
  fs.writeFileSync(gone, '12345');
  fs.writeFileSync(kept, 'abc');
  const report = await reclaimIntermediateSubtitles(
    [gone, kept, missing],
    async () => (target) => target === kept,
  );
  assert.deepEqual(report, {
    files: 1,
    bytes: 5,
    errors: [],
    retained: [kept],
  });
  assert.equal(fs.existsSync(gone), false);
  assert.equal(fs.readFileSync(kept, 'utf8'), 'abc');
});

test('only regular files are deleted, and nobody is asked when none is left to decide', async (t) => {
  const folder = tempFolder(t);
  const directory = path.join(folder, `${uuid}.srt`);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'inner.txt'), 'x');
  const target = path.join(folder, 'real.txt');
  fs.writeFileSync(target, 'precious');
  const link = path.join(folder, `${md5}-source.srt`);
  if (process.platform !== 'win32') fs.symlinkSync(target, link);
  let asked = 0;
  const report = await reclaimIntermediateSubtitles(
    [directory, link, path.join(folder, `${md5}-final.srt`)],
    async () => {
      asked += 1;
      return () => false;
    },
  );
  assert.equal(asked, 0);
  assert.deepEqual(report, { files: 0, bytes: 0, errors: [], retained: [] });
  assert.ok(fs.existsSync(path.join(directory, 'inner.txt')));
  assert.equal(fs.readFileSync(target, 'utf8'), 'precious');
});

test('a subtitle that cannot be deleted is reported and the others still go', async (t) => {
  const folder = tempFolder(t);
  const stuck = path.join(folder, `${uuid}.srt`);
  const fine = path.join(folder, `${md5}-final.srt`);
  fs.writeFileSync(stuck, 'a');
  fs.writeFileSync(fine, 'b');
  const unlink = fs.promises.unlink;
  const mock = t.mock.method(fs.promises, 'unlink', async (file: any) => {
    if (file === stuck)
      throw Object.assign(new Error('EPERM: stuck'), { code: 'EPERM' });
    return unlink(file);
  });
  const report = await reclaimIntermediateSubtitles(
    [stuck, fine],
    async () => () => false,
  );
  mock.mock.restore();
  assert.equal(report.files, 1);
  assert.equal(fs.existsSync(fine), false);
  assert.ok(fs.existsSync(stuck));
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /EPERM: stuck/);
});

test('a failure to collect the references deletes no subtitle', async (t) => {
  const folder = tempFolder(t);
  const file = path.join(folder, `${uuid}.srt`);
  fs.writeFileSync(file, 'a');
  const report = await reclaimIntermediateSubtitles([file], async () => {
    throw new Error('TASK_DRAFT_IDENTITY_UNKNOWN');
  });
  assert.equal(report.files, 0);
  assert.ok(fs.existsSync(file));
  assert.match(report.errors.join(), /TASK_DRAFT_IDENTITY_UNKNOWN/);
});
