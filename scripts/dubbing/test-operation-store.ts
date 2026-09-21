import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DubbingOperationRegistry } from '../../main/helpers/dubbing/operationRegistry';
import { DubbingOperationStore } from '../../main/helpers/dubbing/operationStore';
import {
  setDubbingSessionsRoot,
  getSessionDir,
  stageSessionDeletion,
  getSessionDraftPath,
} from '../../main/helpers/dubbing/sessionStore';
import { recoverDubbingArtifacts } from '../../main/helpers/dubbing/recoverArtifacts';

async function main() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-operation-store-'),
  );
  setDubbingSessionsRoot(root);
  const seedCreation = (id: string, fields = {}) => {
    const directory = getSessionDir(id);
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, 'session.json'),
      JSON.stringify({
        version: 1,
        sessionId: id,
        pendingTaskLink: true,
        cues: [{ status: 'pending' }],
        ...fields,
      }),
    );
    return directory;
  };
  seedCreation('unlinked-new');
  seedCreation('linked-new');
  seedCreation('pipeline-new');
  seedCreation('legacy-unlinked', { pendingTaskLink: undefined });
  seedCreation('edited-unlinked', { hasSavedTextEdits: true });
  seedCreation('configured-unlinked', { configSnapshot: { speed: 1 } });
  const unknown = seedCreation('unknown-unlinked');
  fs.writeFileSync(path.join(unknown, 'keep.wav'), 'retained');
  seedCreation('draft-unlinked');
  const draft = getSessionDraftPath('draft-unlinked', 'cue');
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, '{corrupt but retained');
  const symlink = seedCreation('symlink-unlinked');
  fs.symlinkSync(
    path.join(unknown, 'keep.wav'),
    path.join(symlink, 'unknown.wav'),
  );
  const creationItems: any = [
    { type: 'dubbing', configSnapshot: { sessionId: 'linked-new' } },
    { pipelineFiles: [{ dubbingSessionId: 'pipeline-new' }] },
  ];
  recoverDubbingArtifacts(creationItems);
  assert.equal(fs.existsSync(getSessionDir('unlinked-new')), false);
  for (const id of ['linked-new', 'pipeline-new']) {
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(getSessionDir(id), 'session.json'), 'utf8'),
      ).pendingTaskLink,
      false,
    );
  }
  for (const id of [
    'legacy-unlinked',
    'edited-unlinked',
    'configured-unlinked',
    'unknown-unlinked',
    'draft-unlinked',
    'symlink-unlinked',
  ])
    assert.ok(fs.existsSync(getSessionDir(id)), id);
  seedCreation('unreadable-creation');
  const readDirectory = fs.readdirSync;
  fs.readdirSync = ((file, ...args) => {
    if (String(file) === getSessionDir('unreadable-creation'))
      throw Object.assign(new Error('creation directory denied'), {
        code: 'EACCES',
      });
    return readDirectory(file, ...args);
  }) as typeof fs.readdirSync;
  try {
    recoverDubbingArtifacts(creationItems);
    assert.ok(fs.existsSync(getSessionDir('unreadable-creation')));
  } finally {
    fs.readdirSync = readDirectory;
  }
  recoverDubbingArtifacts(creationItems);
  assert.equal(fs.existsSync(getSessionDir('unreadable-creation')), false);
  const dir = getSessionDir('session');
  fs.mkdirSync(dir);
  const store = new DubbingOperationStore<any>();
  let registry = new DubbingOperationRegistry(2, store);
  const payload = {
    sessionId: 'session',
    requestId: 'complete',
    config: { speed: 1 },
  };
  let executed = 0;
  const execute = async () => {
    executed++;
    return { success: true, data: { outputPath: '/original.wav' } };
  };
  await registry.run('export', payload, execute);
  registry = new DubbingOperationRegistry(2, store);
  assert.equal(registry.latest('session').status, 'complete');
  assert.deepEqual(await registry.run('export', payload, execute), {
    success: true,
    data: { outputPath: '/original.wav' },
  });
  assert.equal(executed, 1);

  void registry.run(
    'start',
    { ...payload, requestId: 'pending' },
    () => new Promise(() => {}),
  );
  registry = new DubbingOperationRegistry(2, store);
  assert.equal(registry.status('session', 'pending').status, 'interrupted');
  assert.throws(
    () => registry.run('start', { ...payload, requestId: 'pending' }, execute),
    /interrupted/,
  );
  assert.equal(executed, 1);

  const rename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('receipt denied');
  };
  try {
    assert.throws(
      () => registry.run('start', { ...payload, requestId: 'denied' }, execute),
      /receipt denied/,
    );
    assert.equal(executed, 1);
    assert.equal(
      fs
        .readdirSync(path.join(dir, '.operations'))
        .some((file) => file.endsWith('.tmp')),
      false,
    );
  } finally {
    fs.renameSync = rename;
  }

  const result = registry.run(
    'export',
    { ...payload, requestId: 'completion-failure' },
    execute,
  );
  fs.renameSync = () => {
    throw new Error('final receipt denied');
  };
  try {
    assert.equal((await result).success, true);
    assert.equal(
      registry.status('session', 'completion-failure').status,
      'complete',
    );
    const failedReceipt = registry.status('session', 'completion-failure');
    assert.equal(failedReceipt.status, 'complete');
    assert.match(
      failedReceipt.status === 'complete' ? failedReceipt.persistenceError : '',
      /final receipt denied/,
    );
    assert.equal(
      new DubbingOperationRegistry(2, store).status(
        'session',
        'completion-failure',
      ).status,
      'interrupted',
    );
  } finally {
    fs.renameSync = rename;
  }
  const repairedReceipt = registry.status('session', 'completion-failure');
  assert.equal(repairedReceipt.status, 'complete');
  assert.equal(
    repairedReceipt.status === 'complete'
      ? repairedReceipt.persistenceError
      : 'unexpected',
    undefined,
  );
  assert.equal(
    new DubbingOperationRegistry(2, store).status(
      'session',
      'completion-failure',
    ).status,
    'complete',
  );

  const receipt = path.join(
    dir,
    '.operations',
    createHash('sha256').update('complete').digest('hex') + '.json',
  );
  const bytes = fs.readFileSync(receipt);
  fs.writeFileSync(receipt, '{broken');
  assert.throws(() =>
    new DubbingOperationRegistry(2, store).run(
      'start',
      { ...payload, requestId: 'blocked' },
      execute,
    ),
  );
  assert.equal(fs.readFileSync(receipt, 'utf8'), '{broken');
  fs.writeFileSync(receipt, bytes);
  const staged = stageSessionDeletion(['session']);
  assert.equal(fs.existsSync(receipt), false);
  staged.rollback();
  assert.deepEqual(fs.readFileSync(receipt), bytes);

  const saved = 'cue-0-100-12345678.wav';
  const orphan = 'cue-0-200-12345678-atempo.wav';
  const externalRef = 'cue-0-300-12345678.wav';
  for (const file of [saved, orphan, externalRef, 'unknown.wav'])
    fs.writeFileSync(path.join(dir, file), file);
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    JSON.stringify({
      version: 1,
      sessionId: 'session',
      cues: [{ wavFile: saved }],
    }),
  );
  for (const name of ['dub-track-AbC123', 'dub-track-Def456']) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'dub-track.wav'), 'audio');
  }
  const items: any = [
    {
      artifacts: [{ path: path.join(dir, externalRef) }],
      pipelineFiles: [
        {
          dubbedTrackPath: path.join(dir, 'dub-track-AbC123', 'dub-track.wav'),
        },
      ],
    },
  ];
  recoverDubbingArtifacts(items);
  for (const file of [
    saved,
    externalRef,
    'unknown.wav',
    'dub-track-AbC123/dub-track.wav',
  ])
    assert.ok(fs.existsSync(path.join(dir, file)));
  assert.equal(fs.existsSync(path.join(dir, orphan)), false);
  assert.equal(fs.existsSync(path.join(dir, 'dub-track-Def456')), false);
  fs.writeFileSync(path.join(dir, orphan), 'keep unreadable project');
  fs.writeFileSync(path.join(dir, 'session.json'), '{broken');
  recoverDubbingArtifacts(items);
  assert.equal(
    fs.readFileSync(path.join(dir, orphan), 'utf8'),
    'keep unreadable project',
  );
  console.log(
    JSON.stringify({
      root,
      checks:
        'durable acceptance/completion, crash interruption, no reexecution, receipt failures/retry/corruption, deletion rollback, unreferenced internal audio cleanup and reference preservation',
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
