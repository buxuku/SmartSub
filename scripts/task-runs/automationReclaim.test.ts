import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { reclaimAutomationJobs } from '../../main/automation/reclaim';
import { createProtector } from '../../main/helpers/taskRuns/cleanup';

type Job = { id: string; projectId?: string };

function setup(t: any, jobs: Job[]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-reclaim-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outputs = (id: string, ...parts: string[]) =>
    path.join(base, 'outputs', id, ...parts);
  const receipt = (id: string) => path.join(base, 'jobs', `${id}.json`);
  const write = (file: string, content = 'x') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const busy = new Set<string>();
  const discarded: string[] = [];
  const asked: Array<(file: string) => boolean> = [];
  /** Files remaining records are said to read, and the paths each one mentions. */
  const references = new Map<string, string[]>();
  const input = (ids: string[]) => ({
    ids,
    jobs,
    isBusy: (id: string) => busy.has(id),
    outputDirectory: (id: string) => outputs(id),
    receiptPath: receipt,
    discard: (id: string) => {
      discarded.push(id);
      fs.rmSync(receipt(id), { force: true });
    },
    protector: async (ignore: (file: string) => boolean) => {
      asked.push(ignore);
      return createProtector(
        new Set(
          [...references]
            .filter(([file]) => !ignore(file))
            .flatMap(([, paths]) => paths),
        ),
      );
    },
  });
  /** A finished job with a receipt and a default output folder. */
  const seed = (id: string) => {
    write(receipt(id), JSON.stringify({ id }));
    write(outputs(id, '1-clip', 'clip.srt'), '1\n');
    write(outputs(id, '1-clip', 'clip.zh.srt'), '2\n');
  };
  return {
    base,
    outputs,
    receipt,
    write,
    busy,
    discarded,
    asked,
    references,
    input,
    seed,
  };
}

test('the receipt and default outputs of a deleted task go together', async (t) => {
  const jobs = [
    { id: 'a', projectId: 'a' },
    { id: 'z', projectId: 'z' },
  ];
  const { input, seed, outputs, receipt, discarded } = setup(t, jobs);
  seed('a');
  seed('z');
  const report = await reclaimAutomationJobs(input(['a', 'desktop-task']));
  assert.equal(fs.existsSync(outputs('a')), false);
  assert.equal(fs.existsSync(receipt('a')), false);
  assert.ok(
    fs.existsSync(outputs('z', '1-clip', 'clip.srt')),
    'other jobs stay',
  );
  assert.ok(fs.existsSync(receipt('z')));
  assert.deepEqual(discarded, ['a']);
  assert.deepEqual(report, {
    files: 3,
    bytes: 14,
    errors: [],
    retained: [],
  });
});

test('every job of a deleted task goes with it, retries included', async (t) => {
  const jobs = [
    { id: 'a', projectId: 'a' },
    { id: 'retry', projectId: 'a' },
    { id: 'other', projectId: 'other' },
  ];
  const { input, seed, outputs, receipt, write, discarded } = setup(t, jobs);
  seed('a');
  seed('other');
  write(receipt('retry'), '{}');
  await reclaimAutomationJobs(input(['a']));
  assert.deepEqual(discarded.sort(), ['a', 'retry']);
  assert.equal(fs.existsSync(outputs('a')), false);
  assert.ok(fs.existsSync(outputs('other')));
});

test('a job deleted on its own takes its outputs along', async (t) => {
  const jobs = [{ id: 'speech' }];
  const { input, seed, outputs, receipt } = setup(t, jobs);
  seed('speech');
  await reclaimAutomationJobs(input(['speech']));
  assert.equal(fs.existsSync(outputs('speech')), false);
  assert.equal(fs.existsSync(receipt('speech')), false);
});

test('nobody is asked and nothing is touched when no job belongs to the tasks', async (t) => {
  const jobs = [{ id: 'a', projectId: 'a' }];
  const { input, seed, outputs, asked, discarded } = setup(t, jobs);
  seed('a');
  const report = await reclaimAutomationJobs(input(['desktop-only']));
  assert.deepEqual(report, { files: 0, bytes: 0, errors: [], retained: [] });
  assert.equal(asked.length, 0);
  assert.deepEqual(discarded, []);
  assert.ok(fs.existsSync(outputs('a')));
});

test('a job that has not finished keeps its receipt and the outputs of its task', async (t) => {
  const jobs = [
    { id: 'a', projectId: 'a' },
    { id: 'retry', projectId: 'a' },
    { id: 'review', projectId: 'review' },
  ];
  const { input, seed, outputs, receipt, busy, discarded, write } = setup(
    t,
    jobs,
  );
  seed('a');
  seed('review');
  write(receipt('retry'), '{}');
  busy.add('retry');
  busy.add('review');
  const report = await reclaimAutomationJobs(input(['a', 'review']));
  assert.deepEqual(discarded, [], 'a still has a retry going, review waits');
  assert.ok(fs.existsSync(outputs('a', '1-clip', 'clip.srt')));
  assert.ok(fs.existsSync(receipt('a')), 'the owner of held outputs stays too');
  assert.ok(fs.existsSync(receipt('retry')));
  assert.ok(fs.existsSync(outputs('review', '1-clip', 'clip.srt')));
  assert.ok(report.retained.includes(outputs('a')));
  assert.ok(report.retained.includes(receipt('retry')));
  assert.ok(report.retained.includes(receipt('review')));
});

test('outputs a remaining record uses stay, and the receipt still goes', async (t) => {
  const jobs = [{ id: 'a', projectId: 'a' }];
  const { input, seed, outputs, receipt, references, discarded } = setup(
    t,
    jobs,
  );
  seed('a');
  references.set('/records/task.json', [outputs('a', '1-clip', 'clip.srt')]);
  const report = await reclaimAutomationJobs(input(['a']));
  assert.ok(
    fs.existsSync(outputs('a', '1-clip', 'clip.zh.srt')),
    'all of it stays',
  );
  assert.equal(fs.existsSync(receipt('a')), false);
  assert.deepEqual(discarded, ['a']);
  assert.deepEqual(report.retained, [outputs('a')]);
  assert.equal(report.files, 1, 'only the receipt');
});

test('the receipt and the files inside the outputs do not keep the outputs alive', async (t) => {
  const jobs = [
    { id: 'a', projectId: 'a' },
    { id: 'b', projectId: 'b' },
  ];
  const { input, seed, outputs, receipt, references, asked } = setup(t, jobs);
  seed('a');
  seed('b');
  // The receipts and a JSON file in each folder mention the folder's own outputs.
  for (const id of ['a', 'b']) {
    references.set(receipt(id), [outputs(id, '1-clip', 'clip.srt')]);
    references.set(outputs(id, 'words.json'), [
      outputs(id, '1-clip', 'clip.srt'),
    ]);
  }
  // A remaining record still uses b's outputs.
  references.set('/records/task.json', [outputs('b', '1-clip', 'clip.srt')]);
  const report = await reclaimAutomationJobs(input(['a', 'b']));
  assert.equal(asked.length, 1, 'the references are collected once');
  assert.equal(fs.existsSync(outputs('a')), false);
  assert.ok(fs.existsSync(outputs('b', '1-clip', 'clip.srt')));
  assert.deepEqual(report.retained, [outputs('b')]);
  // Whatever the remaining records mention is not ignored.
  const ignore = asked[0];
  assert.equal(ignore('/records/task.json'), false);
  assert.equal(ignore(receipt('a')), true);
  assert.equal(ignore(outputs('b', 'words.json')), true);
  assert.equal(
    ignore(path.join(path.dirname(outputs('a')), 'unknown', 'x.json')),
    false,
  );
});

test('a link or stray file in place of an outputs folder is left alone', async (t) => {
  const jobs = [
    { id: 'link', projectId: 'link' },
    { id: 'file', projectId: 'file' },
  ];
  const { input, base, write, receipt, outputs, asked } = setup(t, jobs);
  const precious = path.join(base, 'precious');
  write(path.join(precious, 'keep.txt'), 'mine');
  write(receipt('link'), '{}');
  write(receipt('file'), '{}');
  fs.mkdirSync(path.dirname(outputs('link')), { recursive: true });
  if (process.platform !== 'win32') fs.symlinkSync(precious, outputs('link'));
  write(outputs('file'), 'not a folder');
  const report = await reclaimAutomationJobs(input(['link', 'file']));
  assert.equal(
    fs.readFileSync(path.join(precious, 'keep.txt'), 'utf8'),
    'mine',
  );
  assert.equal(fs.readFileSync(outputs('file'), 'utf8'), 'not a folder');
  assert.equal(report.errors.length, 0);
  assert.equal(asked.length, 0, 'there was nothing to weigh');
});

test('outputs that cannot be removed keep the receipt for another attempt', async (t) => {
  const jobs = [
    { id: 'stuck', projectId: 'stuck' },
    { id: 'fine', projectId: 'fine' },
  ];
  const { input, seed, outputs, receipt, discarded, base } = setup(t, jobs);
  seed('stuck');
  seed('fine');
  // A link inside the folder makes the removal refuse to continue.
  if (process.platform !== 'win32')
    fs.symlinkSync(base, outputs('stuck', 'link'));
  const report = await reclaimAutomationJobs(input(['stuck', 'fine']));
  assert.equal(fs.existsSync(outputs('fine')), false, 'the others still go');
  assert.deepEqual(
    discarded,
    process.platform === 'win32' ? ['stuck', 'fine'] : ['fine'],
  );
  if (process.platform !== 'win32') {
    assert.ok(fs.existsSync(receipt('stuck')));
    assert.match(report.errors.join(), /TASK_STORAGE_SYMLINK/);
  }
});

test('references that cannot be collected remove no output and keep its receipt', async (t) => {
  const jobs = [
    { id: 'a', projectId: 'a' },
    { id: 'bare', projectId: 'bare' },
  ];
  const { input, seed, outputs, receipt, write, discarded } = setup(t, jobs);
  seed('a');
  write(receipt('bare'), '{}');
  const report = await reclaimAutomationJobs({
    ...input(['a', 'bare']),
    protector: async () => {
      throw new Error('TASK_DRAFT_IDENTITY_UNKNOWN');
    },
  });
  assert.ok(fs.existsSync(outputs('a', '1-clip', 'clip.srt')));
  assert.ok(fs.existsSync(receipt('a')), 'it still has outputs to remove');
  assert.deepEqual(
    discarded,
    ['bare'],
    'a job without outputs needs no references',
  );
  assert.match(report.errors.join(), /TASK_DRAFT_IDENTITY_UNKNOWN/);
});

test('a receipt that is already gone is fine, and one that cannot be forgotten is reported', async (t) => {
  const jobs = [
    { id: 'gone', projectId: 'gone' },
    { id: 'locked', projectId: 'locked' },
    { id: 'after', projectId: 'after' },
  ];
  const { input, seed, receipt, discarded, outputs } = setup(t, jobs);
  seed('gone');
  seed('locked');
  seed('after');
  fs.rmSync(receipt('gone'));
  const report = await reclaimAutomationJobs({
    ...input(['gone', 'locked', 'after']),
    discard: (id: string) => {
      discarded.push(id);
      if (id === 'locked') throw new Error('EPERM: locked');
      fs.rmSync(receipt(id), { force: true });
    },
  });
  assert.deepEqual(discarded.sort(), ['after', 'gone', 'locked']);
  // the outputs of all three, and only the receipt that was there and could be forgotten
  assert.equal(report.files, 7);
  assert.equal(report.bytes, 26);
  assert.match(report.errors.join(), /EPERM: locked/);
  assert.equal(fs.existsSync(outputs('after')), false, 'the rest carries on');
});

test('ids that are not plain names are never turned into paths', async (t) => {
  const { base, write } = setup(t, []);
  const outside = write(path.join(base, 'escape', 'x.txt'));
  const run = async (jobs: Job[], ids: string[]) => {
    const { input, asked, discarded } = setup(t, jobs);
    const unsafe = {
      ...input(ids),
      outputDirectory: (id: string) => path.join(base, 'outputs', id),
    };
    const report = await reclaimAutomationJobs(unsafe);
    return { report, asked, discarded };
  };
  // as the id of a job ...
  const asJob = await run([{ id: '../escape' }], ['../escape']);
  assert.ok(fs.existsSync(outside));
  assert.equal(asJob.asked.length, 0);
  assert.deepEqual(asJob.discarded, []);
  assert.deepEqual(asJob.report, {
    files: 0,
    bytes: 0,
    errors: [],
    retained: [],
  });
  // ... and as the task a job belongs to
  const asProject = await run(
    [{ id: 'a', projectId: '../escape' }],
    ['../escape'],
  );
  assert.ok(fs.existsSync(outside));
  assert.equal(asProject.asked.length, 0);
  assert.deepEqual(asProject.discarded, ['a'], 'the job itself is fine');
});
