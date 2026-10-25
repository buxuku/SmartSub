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

test('artifact publication syncs both copied data and state with writable handles (Windows)', async (t) => {
  const { artifacts, workspace } = setup(t);
  const source = path.join(workspace, 'source.srt');
  fs.writeFileSync(source, 'original');
  const open = fs.promises.open.bind(fs.promises);
  const synced: string[] = [];
  t.mock.method(
    fs.promises,
    'open',
    async (target: string, flags: string, ...args: any[]) => {
      const handle = await open(target, flags, ...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        // Windows FlushFileBuffers rejects handles opened without write access.
        if (flags === 'r')
          throw Object.assign(
            new Error('EPERM: operation not permitted, fsync'),
            { code: 'EPERM' },
          );
        synced.push(path.basename(target));
        return sync();
      };
      return handle;
    },
  );
  const result = await artifacts.commit(token, workspace, 'f', {
    srtFile: source,
  });
  assert.deepEqual(synced, ['0-source.srt', 'state.json']);
  assert.equal(fs.readFileSync(result.patch.srtFile, 'utf8'), 'original');
  assert.equal(fs.readFileSync(source, 'utf8'), 'original');
  assert.ok(await artifacts.validate(result.artifacts));
});

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

test('bundles preserve distinct same-named files and deduplicate repeated references', async (t) => {
  const { artifacts, workspace } = setup(t);
  const source = path.join(workspace, 'source', 'subtitles.srt');
  const target = path.join(workspace, 'target', 'subtitles.srt');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, 'source text');
  fs.writeFileSync(target, 'target text');
  const committed = await artifacts.commit(token, workspace, 'fingerprint', {
    source,
    target,
    copies: [source, target, target],
    deliveries: [{ source: target }],
  });
  assert.notEqual(committed.patch.source, committed.patch.target);
  assert.equal(fs.readFileSync(committed.patch.source, 'utf8'), 'source text');
  assert.equal(fs.readFileSync(committed.patch.target, 'utf8'), 'target text');
  assert.equal(committed.patch.copies[1], committed.patch.target);
  assert.equal(committed.artifacts.length, 3);
  assert.ok(await artifacts.validate(committed.artifacts));
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

test('delivery rendering leaves canonical translation unchanged and applies bilingual/punctuation choices', async () => {
  const { renderTranslationDelivery } = await import(
    '../../main/helpers/taskRuns/deliveryText'
  );
  const source = '1\n00:00:00,000 --> 00:00:01,000\nHello.\n\n';
  const target = '1\n00:00:00,000 --> 00:00:01,000\n你好，世界！\n\n';
  const rendered = renderTranslationDelivery(source, target, {
    taskType: 'generateAndTranslate',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    translateContent: 'sourceAndTranslate',
    removeChinesePunctuation: true,
  });
  assert.ok(rendered.content.includes('Hello.\n你好 世界'));
  assert.ok(target.includes('，'));
  assert.equal(rendered.bilingual[0].source, 'Hello.');
});
