import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import {
  createStageArtifactStore,
  copyIndependent,
  hashFile,
} from '../../main/helpers/taskRuns/artifacts';
const token = {
  projectId: 'p',
  runId: 'run',
  fileId: 'file',
  stageId: 'extractSubtitle' as const,
  attemptId: 'attempt',
};
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifacts = createStageArtifactStore(createTaskRunStore(root));
  return { root, artifacts, workspace: artifacts.workspace(token) };
}
test('committed artifacts are independent of attempt inputs and reject later corruption', async (t) => {
  const { artifacts, workspace } = setup(t);
  const source = path.join(workspace, 'source.srt');
  fs.writeFileSync(source, 'raw ASR');
  const committed = await artifacts.commit(token, workspace, 'fingerprint', {
    srtFile: source,
    missedSpeechWarnings: [{ start: 1 }],
  });
  assert.ok(await artifacts.validate(committed.artifacts));
  assert.equal(fs.readFileSync(committed.patch.srtFile, 'utf8'), 'raw ASR');
  const transformed = path.join(workspace, 'refined.srt');
  await copyIndependent(committed.patch.srtFile, transformed);
  fs.writeFileSync(transformed, 'refined');
  assert.equal(fs.readFileSync(committed.patch.srtFile, 'utf8'), 'raw ASR');
  fs.writeFileSync(committed.patch.srtFile, 'corrupt');
  assert.equal(await artifacts.validate(committed.artifacts), false);
});
test('cancel before publication produces no committed artifact and preserves the previous output', async (t) => {
  const { artifacts, workspace } = setup(t);
  const source = path.join(workspace, 'source.srt');
  fs.writeFileSync(source, 'raw');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    artifacts.commit(
      token,
      workspace,
      'f',
      { srtFile: source },
      controller.signal,
    ),
  );
  const target = path.join(
    artifacts.fileDirectory('p', 'run', 'file'),
    'artifacts',
  );
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.readFileSync(source, 'utf8'), 'raw');
});
test('full hash detects replacement with identical path, size and mtime', async (t) => {
  const { root } = setup(t);
  const target = path.join(root, 'media');
  fs.writeFileSync(target, 'first');
  const stat = fs.statSync(target);
  const before = await hashFile(target);
  fs.writeFileSync(target, 'other');
  fs.utimesSync(target, stat.atime, stat.mtime);
  const after = await hashFile(target);
  assert.notEqual(before.digest, after.digest);
});
test('hashing supports cancellation during a large read', async (t) => {
  const { root } = setup(t);
  const target = path.join(root, 'media');
  fs.writeFileSync(target, Buffer.alloc(4 * 1024 * 1024));
  const controller = new AbortController();
  await assert.rejects(
    hashFile(target, controller.signal, () => controller.abort()),
  );
});
