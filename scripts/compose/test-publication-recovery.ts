import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createComposeOutput,
  type ComposePublicationState,
} from '../../main/helpers/compose/composeOutput';
import { inspectPublication } from '../../main/helpers/compose/publicationRecovery';

async function main() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-publication-recovery-'),
  );
  const signal = new AbortController().signal;
  let snapshot: ComposePublicationState;
  const snapshots: ComposePublicationState[] = [];
  const job = createComposeOutput(path.join(root, 'out.wav'), [], (state) => {
    snapshot = state;
    snapshots.push(state);
  });
  fs.writeFileSync(job.staged, 'audio');
  const captions = path.join(job.directory, 'captions.srt');
  fs.writeFileSync(captions, 'captions');
  const output = await job.publish(signal, [
    { stagedPath: captions, suffix: '.srt' },
  ]);
  const beforeFinalCheckpoint = snapshots.find(
    (state) => state.phase === 'publishing',
  );
  const recovered = inspectPublication(beforeFinalCheckpoint);
  assert.equal(recovered.complete, true);
  assert.equal(recovered.paths[0], fs.realpathSync(output));
  recovered.cleanup();
  assert.equal(fs.existsSync(job.directory), false);
  assert.equal(fs.readFileSync(output, 'utf8'), 'audio');
  // Committed outputs remain user-owned even if later changed in place.
  fs.writeFileSync(output, 'modified by user');
  inspectPublication(snapshot).cleanup(false);
  assert.equal(fs.readFileSync(output, 'utf8'), 'modified by user');

  const partial = createComposeOutput(
    path.join(root, 'partial.wav'),
    [],
    (state) => {
      snapshot = state;
    },
  );
  fs.writeFileSync(partial.staged, 'audio');
  const sub = path.join(partial.directory, 'captions.srt');
  fs.writeFileSync(sub, 'captions');
  await partial.publish(signal, [{ stagedPath: sub, suffix: '.srt' }]);
  fs.unlinkSync(snapshot.files[1].target);
  const interrupted = inspectPublication(snapshot);
  assert.equal(interrupted.complete, false);
  interrupted.cleanup();
  assert.equal(fs.existsSync(snapshot.files[0].target), false);

  const replaced = createComposeOutput(
    path.join(root, 'replaced.wav'),
    [],
    (state) => {
      snapshot = state;
    },
  );
  fs.writeFileSync(replaced.staged, 'original');
  const replacementSub = path.join(replaced.directory, 'captions.srt');
  fs.writeFileSync(replacementSub, 'captions');
  await replaced.publish(signal, [
    { stagedPath: replacementSub, suffix: '.srt' },
  ]);
  fs.unlinkSync(snapshot.files[1].target);
  fs.unlinkSync(snapshot.files[0].target);
  fs.writeFileSync(snapshot.files[0].target, 'external replacement');
  inspectPublication(snapshot).cleanup();
  for (const phase of ['created', 'publishing', 'published'] as const) {
    const target = path.join(root, `checkpoint-${phase}.wav`);
    let job: ReturnType<typeof createComposeOutput> | undefined;
    const execute = async () => {
      job = createComposeOutput(target, [], (state) => {
        if (state.phase === phase) throw new Error('checkpoint disk full');
      });
      fs.writeFileSync(job.staged, 'audio');
      await job.publish(signal);
    };
    await assert.rejects(execute(), /checkpoint disk full/);
    job?.cleanup();
    assert.equal(fs.existsSync(target), false);
  }
  const changedDirectory = createComposeOutput(
    path.join(root, 'replaced-directory.wav'),
    [],
  );
  const oldDirectory = changedDirectory.directory + '-original';
  fs.renameSync(changedDirectory.directory, oldDirectory);
  fs.mkdirSync(changedDirectory.directory);
  fs.writeFileSync(
    path.join(changedDirectory.directory, 'user-data'),
    'must remain',
  );
  assert.throws(() => changedDirectory.cleanup(), /replaced/);
  assert.equal(
    fs.readFileSync(path.join(changedDirectory.directory, 'user-data'), 'utf8'),
    'must remain',
  );
  assert.equal(
    fs.readFileSync(snapshot.files[0].target, 'utf8'),
    'external replacement',
  );

  const link = fs.linkSync;
  let copySnapshot: ComposePublicationState;
  fs.linkSync = () => {
    throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
  };
  try {
    const copied = createComposeOutput(
      path.join(root, 'copy.wav'),
      [],
      (state) => {
        copySnapshot = state;
      },
    );
    fs.writeFileSync(copied.staged, 'copied bytes');
    await copied.publish(signal);
    assert.equal(inspectPublication(copySnapshot).complete, true);
    inspectPublication(copySnapshot).cleanup();
    assert.equal(
      fs.readFileSync(path.join(root, 'copy.wav'), 'utf8'),
      'copied bytes',
    );
  } finally {
    fs.linkSync = link;
  }
  assert.throws(
    () => inspectPublication({ ...copySnapshot, directory: root }),
    /directory/,
  );
  assert.throws(
    () =>
      inspectPublication({
        ...copySnapshot,
        files: [{ ...copySnapshot.files[0], target: '/unrelated/file.wav' }],
      }),
    /escaped/,
  );

  const copying = createComposeOutput(
    path.join(root, 'copying.wav'),
    [],
    (state) => {
      snapshot = state;
    },
  );
  fs.writeFileSync(copying.staged, 'full copy contents');
  const partialTarget = path.join(root, 'copying.wav');
  fs.writeFileSync(partialTarget, '');
  const owned = fs.statSync(partialTarget);
  const sourceStat = fs.statSync(copying.staged);
  const identify = (stat: fs.Stats) => ({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
  snapshot = {
    ...snapshot,
    phase: 'publishing',
    files: [
      {
        source: copying.staged,
        target: fs.realpathSync(partialTarget),
        mode: 'copy',
        owned: identify(owned),
        sourceIdentity: identify(sourceStat),
      },
    ],
  };
  fs.writeFileSync(partialTarget, 'partial');
  const interruptedCopy = inspectPublication(snapshot);
  assert.equal(interruptedCopy.complete, false);
  interruptedCopy.cleanup();
  assert.equal(fs.existsSync(partialTarget), false);

  const unreadable = createComposeOutput(
    path.join(root, 'unreadable.wav'),
    [],
    (state) => {
      snapshot = state;
    },
  );
  fs.writeFileSync(unreadable.staged, 'audio');
  await unreadable.publish(signal);
  const lstat = fs.lstatSync;
  fs.lstatSync = ((file, ...rest) => {
    if (file === snapshot.files[0].target)
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return lstat(file, ...rest);
  }) as typeof fs.lstatSync;
  try {
    assert.throws(() => inspectPublication(snapshot), /denied/);
  } finally {
    fs.lstatSync = lstat;
  }
  assert.equal(fs.existsSync(unreadable.directory), true);
  inspectPublication(snapshot).cleanup();
  console.log(
    JSON.stringify({
      root,
      checks:
        'pre-final-checkpoint complete group recovery, staged cleanup, partial group rollback, external replacement and modified committed output preservation, exclusive-copy recovery, path validation and unreadable target retention',
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
