import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createComposeOutput } from '../../main/helpers/compose/composeOutput';

async function main() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-compose-output-'),
  );
  const source = path.join(root, 'source.mp4');
  const desired = path.join(root, 'result.mp4');
  fs.writeFileSync(source, 'source bytes');
  fs.writeFileSync(desired, 'existing export');
  assert.throws(() => createComposeOutput(source, [source]), /input file/);
  const hardlink = path.join(root, 'source-link.mp4');
  fs.linkSync(source, hardlink);
  assert.throws(() => createComposeOutput(hardlink, [source]), /input file/);
  const symlink = path.join(root, 'source-symlink.mp4');
  fs.symlinkSync(source, symlink);
  assert.throws(() => createComposeOutput(symlink, [source]), /input file/);
  assert.throws(() => createComposeOutput(root, [source]));
  assert.throws(() => createComposeOutput('relative.mp4', [source]));
  const aborted = createComposeOutput(desired, [source]);
  fs.writeFileSync(aborted.staged, 'partial');
  assert.equal(fs.readFileSync(desired, 'utf8'), 'existing export');
  const signal = new AbortController();
  signal.abort();
  await assert.rejects(aborted.publish(signal.signal));
  aborted.cleanup();
  assert.equal(fs.readFileSync(desired, 'utf8'), 'existing export');
  const work = [
    createComposeOutput(desired, [source]),
    createComposeOutput(desired, [source]),
  ];
  work.forEach((job, i) => fs.writeFileSync(job.staged, `result ${i}`));
  const published = await Promise.all(
    work.map((job) => job.publish(new AbortController().signal)),
  );
  assert.equal(new Set(published).size, 2);
  assert.deepEqual(
    published.map((file) => fs.readFileSync(file, 'utf8')),
    ['result 0', 'result 1'],
  );
  work.forEach((job) => job.cleanup());
  assert.equal(fs.readFileSync(desired, 'utf8'), 'existing export');
  assert.equal(fs.readFileSync(source, 'utf8'), 'source bytes');

  const latePath = path.join(root, 'late.mp4');
  const late = createComposeOutput(latePath, [source]);
  fs.writeFileSync(late.staged, 'late export');
  fs.linkSync(source, latePath);
  assert.equal(
    await late.publish(new AbortController().signal),
    path.join(root, 'late_2.mp4'),
  );
  assert.equal(fs.readFileSync(latePath, 'utf8'), 'source bytes');
  late.cleanup();

  const paired = createComposeOutput(path.join(root, 'paired.wav'), [source]);
  const captions = path.join(paired.directory, 'captions.srt');
  fs.writeFileSync(paired.staged, 'complete audio');
  fs.writeFileSync(captions, 'complete captions');
  fs.writeFileSync(path.join(root, 'paired.dubbed.srt'), 'prior captions');
  assert.equal(
    await paired.publish(new AbortController().signal, [
      { stagedPath: captions, suffix: '.dubbed.srt' },
    ]),
    path.join(root, 'paired_2.wav'),
  );
  assert.equal(fs.existsSync(path.join(root, 'paired.wav')), false);
  assert.equal(
    fs.readFileSync(path.join(root, 'paired.dubbed.srt'), 'utf8'),
    'prior captions',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'paired_2.dubbed.srt'), 'utf8'),
    'complete captions',
  );
  await assert.rejects(
    paired.publish(new AbortController().signal, [
      { stagedPath: captions, suffix: '/../bad' },
    ]),
    /suffix/,
  );
  paired.cleanup();

  const pairLink = fs.linkSync;
  for (const replace of [false, true]) {
    const desired = path.join(root, `pair-failure-${replace}.wav`);
    const job = createComposeOutput(desired, [source]);
    fs.writeFileSync(job.staged, 'audio');
    const subtitle = path.join(job.directory, 'captions.srt');
    fs.writeFileSync(subtitle, 'captions');
    fs.linkSync = ((from, to) => {
      if (from === subtitle) {
        if (replace) {
          fs.unlinkSync(desired);
          fs.writeFileSync(desired, 'replacement');
        }
        throw Object.assign(new Error('subtitle disk full'), {
          code: 'ENOSPC',
        });
      }
      return pairLink(from, to);
    }) as typeof fs.linkSync;
    try {
      await assert.rejects(
        job.publish(new AbortController().signal, [
          { stagedPath: subtitle, suffix: '.dubbed.srt' },
        ]),
        /disk full/,
      );
    } finally {
      fs.linkSync = pairLink;
      job.cleanup();
    }
    if (replace) assert.equal(fs.readFileSync(desired, 'utf8'), 'replacement');
    else assert.equal(fs.existsSync(desired), false);
  }

  const link = fs.linkSync;
  const writeStream = fs.createWriteStream;
  try {
    fs.linkSync = () => {
      throw Object.assign(new Error('Links unsupported'), { code: 'ENOTSUP' });
    };
    const job = createComposeOutput(desired, [source]);
    fs.writeFileSync(job.staged, Buffer.alloc(1024 * 1024, 7));
    const file = await job.publish(new AbortController().signal);
    assert.deepEqual(fs.readFileSync(file), Buffer.alloc(1024 * 1024, 7));
    job.cleanup();
    const cancel = createComposeOutput(path.join(root, 'cancel.mp4'), [source]);
    fs.writeFileSync(cancel.staged, Buffer.alloc(8 * 1024 * 1024, 9));
    const controller = new AbortController();
    const pending = cancel.publish(controller.signal);
    setImmediate(() => controller.abort());
    await assert.rejects(pending);
    assert.equal(fs.existsSync(path.join(root, 'cancel.mp4')), false);
    cancel.cleanup();

    for (const replace of [false, true]) {
      const failedPath = path.join(root, `copy-failure-${replace}.mp4`);
      const failed = createComposeOutput(failedPath, [source]);
      fs.writeFileSync(failed.staged, 'complete staged data');
      fs.createWriteStream = (() =>
        new Writable({
          write(_chunk, _encoding, callback) {
            if (replace) {
              fs.unlinkSync(failedPath);
              fs.writeFileSync(failedPath, 'concurrent replacement');
            }
            callback(
              Object.assign(new Error('Injected disk full'), {
                code: 'ENOSPC',
              }),
            );
          },
        })) as typeof fs.createWriteStream;
      await assert.rejects(
        failed.publish(new AbortController().signal),
        /disk full/,
      );
      if (replace)
        assert.equal(
          fs.readFileSync(failedPath, 'utf8'),
          'concurrent replacement',
        );
      else assert.equal(fs.existsSync(failedPath), false);
      failed.cleanup();
    }
  } finally {
    fs.linkSync = link;
    fs.createWriteStream = writeStream;
  }
  const empty = createComposeOutput(path.join(root, 'empty.mp4'), [source]);
  fs.writeFileSync(empty.staged, '');
  await assert.rejects(
    empty.publish(new AbortController().signal),
    /no output/,
  );
  empty.cleanup();
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith('.smartsub-compose-')),
    false,
  );
  console.log(
    JSON.stringify({
      root,
      checks:
        'input/hardlink/symlink protection, existing and late-collision preservation, concurrent publication, cancellation, unsupported-link fallback, copy failure cleanup and concurrent replacement ownership, empty result, cleanup',
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
