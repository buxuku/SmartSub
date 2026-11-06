import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setDubbingSessionsRoot,
  getSessionDir,
  getSessionDraftPath,
  stageSessionDeletion,
  recoverSessionDeletions,
  deleteSessionData,
  assertSessionAvailable,
} from '../../main/helpers/dubbing/sessionStore';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-session-delete-'));
setDubbingSessionsRoot(root);
const seed = (id: string) => {
  fs.mkdirSync(getSessionDir(id), { recursive: true });
  fs.writeFileSync(path.join(getSessionDir(id), 'audio.wav'), 'original audio');
  for (const kind of ['config', 'cue'] as const) {
    const file = getSessionDraftPath(id, kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{original ${kind} bytes`);
  }
};
const intact = (id: string) => {
  assert.equal(
    fs.readFileSync(path.join(getSessionDir(id), 'audio.wav'), 'utf8'),
    'original audio',
  );
  for (const kind of ['config', 'cue'] as const)
    assert.equal(
      fs.readFileSync(getSessionDraftPath(id, kind), 'utf8'),
      `{original ${kind} bytes`,
    );
};
const gone = (id: string) => {
  assert.equal(fs.existsSync(getSessionDir(id)), false);
  for (const kind of ['config', 'cue'] as const)
    assert.equal(fs.existsSync(getSessionDraftPath(id, kind)), false);
};
for (const id of ['../escape', '.', '/', 'nested/path', ''])
  assert.throws(() => getSessionDir(id), /Invalid/);
seed('a');
seed('b');
const txn = stageSessionDeletion(['a', 'b']);
gone('a');
gone('b');
txn.rollback();
intact('a');
intact('b');
const rename = fs.renameSync;
let count = 0;
fs.renameSync = (...args) => {
  if (++count === 5) throw new Error('stage failure');
  return rename(...args);
};
try {
  assert.throws(() => stageSessionDeletion(['a', 'b']), /stage failure/);
} finally {
  fs.renameSync = rename;
}
intact('a');
intact('b');
stageSessionDeletion(['a', 'b']);
recoverSessionDeletions(new Set(['a', 'b']));
intact('a');
intact('b');
stageSessionDeletion(['a', 'b']);
recoverSessionDeletions(new Set(['a']));
intact('a');
gone('b');
const committed = stageSessionDeletion(['a']);
committed.commit();
gone('a');
seed('cleanup');
const deferred = stageSessionDeletion(['cleanup']);
const rm = fs.rmSync;
fs.rmSync = () => {
  throw new Error('cleanup denied');
};
try {
  deferred.commit();
} finally {
  fs.rmSync = rm;
}
assert.equal(fs.readdirSync(path.join(root, '.deleted')).length, 1);
recoverSessionDeletions(new Set());
assert.equal(fs.readdirSync(path.join(root, '.deleted')).length, 0);
seed('explicit');
deleteSessionData('explicit');
gone('explicit');
seed('conflict');
stageSessionDeletion(['conflict']);
fs.mkdirSync(getSessionDir('conflict'));
recoverSessionDeletions(new Set(['conflict']));
assert.throws(
  () => assertSessionAvailable('conflict'),
  /recovery is incomplete/,
);
fs.rmdirSync(getSessionDir('conflict'));
recoverSessionDeletions(new Set(['conflict']));
assert.doesNotThrow(() => assertSessionAvailable('conflict'));
intact('conflict');
seed('unreadable-entry');
stageSessionDeletion(['unreadable-entry']);
const lstat = fs.lstatSync;
fs.lstatSync = ((file, ...rest) => {
  if (String(file).endsWith('unreadable-entry.session'))
    throw Object.assign(new Error('staged entry denied'), { code: 'EACCES' });
  return lstat(file, ...rest);
}) as typeof fs.lstatSync;
try {
  recoverSessionDeletions(new Set(['unreadable-entry']));
  assert.throws(
    () => assertSessionAvailable('unreadable-entry'),
    /recovery is incomplete/,
  );
  assert.equal(fs.readdirSync(path.join(root, '.deleted')).length, 1);
} finally {
  fs.lstatSync = lstat;
}
recoverSessionDeletions(new Set(['unreadable-entry']));
intact('unreadable-entry');
assert.doesNotThrow(() => assertSessionAvailable('unreadable-entry'));
seed('rollback-failure');
count = 0;
fs.renameSync = (...args) => {
  if (++count >= 3) throw new Error('stage and rollback denied');
  return rename(...args);
};
try {
  assert.throws(
    () => stageSessionDeletion(['rollback-failure']),
    /stage and rollback denied/,
  );
  assert.throws(
    () => assertSessionAvailable('rollback-failure'),
    /recovery is incomplete/,
  );
} finally {
  fs.renameSync = rename;
}
recoverSessionDeletions(new Set(['rollback-failure']));
assert.doesNotThrow(() => assertSessionAvailable('rollback-failure'));
intact('rollback-failure');

const sync = fs.fsyncSync;
fs.fsyncSync = () => {
  throw new Error('manifest sync denied');
};
try {
  assert.throws(
    () => stageSessionDeletion(['conflict']),
    /manifest sync denied/,
  );
} finally {
  fs.fsyncSync = sync;
}
intact('conflict');
assert.equal(fs.readdirSync(path.join(root, '.deleted')).length, 0);

const readdir = fs.readdirSync;
fs.readdirSync = (() => {
  throw Object.assign(new Error('directory denied'), { code: 'EACCES' });
}) as typeof fs.readdirSync;
try {
  assert.doesNotThrow(() => recoverSessionDeletions(new Set(['conflict'])));
  assert.throws(
    () => assertSessionAvailable('conflict'),
    /recovery is incomplete/,
  );
  assert.throws(
    () => stageSessionDeletion(['conflict']),
    /recovery is incomplete/,
  );
} finally {
  fs.readdirSync = readdir;
}
recoverSessionDeletions(new Set(['conflict']));
assert.doesNotThrow(() => assertSessionAvailable('conflict'));

stageSessionDeletion(['conflict']);
const transaction = path.join(
  root,
  '.deleted',
  fs.readdirSync(path.join(root, '.deleted'))[0],
);
const manifestPath = path.join(transaction, 'manifest.json');
const manifestBytes = fs.readFileSync(manifestPath);
fs.writeFileSync(manifestPath, '{broken');
recoverSessionDeletions(new Set(['conflict']));
assert.throws(
  () => assertSessionAvailable('conflict'),
  /recovery is incomplete/,
);
assert.throws(
  () => assertSessionAvailable('unrelated'),
  /recovery is incomplete/,
);
assert.equal(
  fs.readFileSync(
    path.join(transaction, 'conflict.session', 'audio.wav'),
    'utf8',
  ),
  'original audio',
);
fs.writeFileSync(manifestPath, manifestBytes);
recoverSessionDeletions(new Set(['conflict']));
assert.doesNotThrow(() => assertSessionAvailable('conflict'));
assert.doesNotThrow(() => assertSessionAvailable('unrelated'));
intact('conflict');
console.log(
  JSON.stringify({
    root,
    checks:
      'path containment, exact byte rollback, mid-stage and rollback failure, interrupted deletion referenced/unreferenced recovery, cleanup retry, both journals removed, manifest failure cleanup, unreadable recovery directory and corrupt manifest fail closed with retry',
  }),
);
