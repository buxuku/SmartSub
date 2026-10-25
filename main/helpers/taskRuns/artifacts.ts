import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AttemptToken, StageArtifact } from '../../../types/taskRun';
import type { TaskRunStore } from './store';

export async function hashFile(
  filePath: string,
  signal?: AbortSignal,
  progress?: (percent: number) => void,
) {
  signal?.throwIfAborted();
  const before = await fs.promises.stat(filePath);
  if (!before.isFile()) throw new Error('TASK_INPUT_NOT_FILE');
  const hash = createHash('sha256');
  let read = 0;
  const stream = fs.createReadStream(filePath, {
    highWaterMark: 1024 * 1024,
    signal,
  });
  for await (const chunk of stream) {
    hash.update(chunk);
    read += chunk.length;
    progress?.(before.size ? (read / before.size) * 100 : 100);
  }
  const after = await fs.promises.stat(filePath);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.ino !== after.ino ||
    read !== before.size
  )
    throw new Error('TASK_INPUT_CHANGED');
  return {
    digest: hash.digest('hex'),
    identity: {
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      ino: after.ino,
    },
  };
}
export async function copyIndependent(source: string, target: string) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(source, target, fs.constants.COPYFILE_FICLONE);
}
export async function assertInputIdentity(
  filePath: string,
  identity: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
) {
  const now = await fs.promises.stat(filePath);
  for (const key of ['size', 'mtimeMs', 'ctimeMs', 'ino'] as const)
    if (now[key] !== identity[key]) throw new Error('TASK_INPUT_CHANGED');
}
const safeId = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    !!relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};
export function createStageArtifactStore(manifests: TaskRunStore) {
  const runDirectory = (projectId: string, runId: string) =>
    path.dirname(manifests.runPath(projectId, runId));
  const fileDirectory = (projectId: string, runId: string, fileId: string) =>
    path.join(runDirectory(projectId, runId), 'files', safeId(fileId));
  return {
    runDirectory,
    fileDirectory,
    workspace(token: AttemptToken) {
      const directory = path.join(
        fileDirectory(token.projectId, token.runId, token.fileId),
        'attempts',
        `${token.stageId}-${token.attemptId}`,
      );
      fs.mkdirSync(directory, { recursive: true });
      return directory;
    },
    async commit(
      token: AttemptToken,
      workspace: string,
      fingerprint: string,
      patch: Record<string, any>,
      signal?: AbortSignal,
    ) {
      const directory = path.join(
        fileDirectory(token.projectId, token.runId, token.fileId),
        'artifacts',
        `${token.stageId}-${token.attemptId}`,
      );
      const staging = `${directory}.pending-${randomUUID()}`;
      await fs.promises.mkdir(staging, { recursive: true });
      const artifacts: StageArtifact[] = [];
      const copied = new Map<string, string>();
      async function capture(value: any, key: string): Promise<any> {
        if (
          typeof value === 'string' &&
          path.isAbsolute(value) &&
          within(workspace, value) &&
          fs.existsSync(value) &&
          fs.statSync(value).isFile()
        ) {
          if (copied.has(value)) return copied.get(value);
          const name = `${artifacts.length}-${path.basename(value)}`;
          const target = path.join(staging, name);
          await copyIndependent(value, target);
          const { digest, identity } = await hashFile(target, signal);
          // Windows requires write access to flush a file. This is our private
          // staging copy; r+ preserves its contents until atomic publication.
          const handle = await fs.promises.open(target, 'r+');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          const final = path.join(directory, name);
          copied.set(value, final);
          artifacts.push({
            id: randomUUID(),
            path: final,
            digest,
            size: identity.size,
            kind: key,
            provenance: 'automatic',
            producer: {
              runId: token.runId,
              fileId: token.fileId,
              stageId: token.stageId,
              fingerprint,
            },
          });
          return final;
        }
        // Capture in order: names and reference deduplication share bundle state.
        // Parallel walks could copy two files to the same index before either hash completes.
        if (Array.isArray(value)) {
          const result = [];
          for (const item of value) result.push(await capture(item, key));
          return result;
        }
        if (value && typeof value === 'object') {
          const result: Record<string, any> = {};
          for (const [child, item] of Object.entries(value))
            result[child] = await capture(item, child);
          return result;
        }
        return value;
      }
      try {
        const committed = await capture(patch, 'result');
        const statePath = path.join(staging, 'state.json');
        await fs.promises.writeFile(statePath, JSON.stringify(committed), {
          mode: 0o600,
        });
        const { digest, identity } = await hashFile(statePath, signal);
        const handle = await fs.promises.open(statePath, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        artifacts.push({
          id: randomUUID(),
          path: path.join(directory, 'state.json'),
          digest,
          size: identity.size,
          kind: 'state',
          provenance: 'automatic',
          producer: {
            runId: token.runId,
            fileId: token.fileId,
            stageId: token.stageId,
            fingerprint,
          },
        });
        signal?.throwIfAborted();
        await fs.promises.rename(staging, directory);
        return { artifacts, patch: committed };
      } catch (error) {
        await fs.promises.rm(staging, { recursive: true, force: true });
        throw error;
      }
    },
    async validate(artifacts: StageArtifact[], signal?: AbortSignal) {
      if (!artifacts.length || !artifacts.some((a) => a.kind === 'state'))
        return false;
      for (const artifact of artifacts) {
        if (
          !within(manifests.root, artifact.path) ||
          artifact.provenance !== 'automatic'
        )
          return false;
        try {
          const result = await hashFile(artifact.path, signal);
          if (
            result.digest !== artifact.digest ||
            result.identity.size !== artifact.size
          )
            return false;
        } catch (error) {
          if (signal?.aborted) throw error;
          return false;
        }
      }
      return true;
    },
    readPatch(artifacts: StageArtifact[]) {
      const state = artifacts.find((a) => a.kind === 'state');
      if (!state) throw new Error('TASK_ARTIFACT_MISSING');
      return JSON.parse(fs.readFileSync(state.path, 'utf8'));
    },
  };
}
export type StageArtifactStore = ReturnType<typeof createStageArtifactStore>;
