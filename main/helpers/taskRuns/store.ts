import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  TASK_RUN_SCHEMA_VERSION,
  type TaskRun,
  type TaskDraft,
} from '../../../types/taskRun';
import type { TaskRunLocations } from './locations';
import { within } from './storageIO';
import { assertTaskStorageWritable } from './maintenance';

export function createTaskRunStore(
  initialRoot: string,
  operations: typeof fs = fs,
  locations?: TaskRunLocations,
) {
  const root = () => locations?.root ?? initialRoot;
  const roots = () => locations?.roots() ?? [initialRoot];
  const projectHash = (id: string) =>
    createHash('sha256').update(id).digest('hex');
  const projectPath = (id: string) => path.join(root(), projectHash(id));
  const keyFor = (id: string, runId: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('TASK_RUN_ID_INVALID');
    return path.join(projectHash(id), runId);
  };
  function runPath(projectId: string, runId: string) {
    const key = keyFor(projectId, runId);
    const pinned = locations?.pinned(key);
    if (pinned) return path.join(pinned, key, 'manifest.json');
    const candidates = roots().filter((base) =>
      operations.existsSync(path.join(base, key, 'manifest.json')),
    );
    if (candidates.length > 1) throw new Error('TASK_STORAGE_CONFLICT');
    return path.join(candidates[0] ?? root(), key, 'manifest.json');
  }
  function readJson<T>(target: string): T | null {
    try {
      return JSON.parse(operations.readFileSync(target, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  function validate(run: TaskRun | null) {
    if (run && run.schemaVersion !== TASK_RUN_SCHEMA_VERSION)
      throw new Error('TASK_RUN_VERSION_UNSUPPORTED');
    return run;
  }
  function writeJson(target: string, value: unknown) {
    operations.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = operations.openSync(temporary, 'wx', 0o600);
      operations.writeFileSync(fd, JSON.stringify(value));
      operations.fsyncSync(fd);
      operations.closeSync(fd);
      fd = undefined;
      operations.renameSync(temporary, target);
    } finally {
      if (fd !== undefined) operations.closeSync(fd);
      if (operations.existsSync(temporary)) operations.unlinkSync(temporary);
    }
  }
  function read(projectId: string, runId: string) {
    const key = keyFor(projectId, runId);
    const target = runPath(projectId, runId);
    const run = validate(readJson<TaskRun>(target));
    if (!run && locations?.pinned(key))
      throw new Error(`TASK_STORAGE_UNAVAILABLE: ${target}`);
    if (run)
      locations?.pin(key, path.dirname(path.dirname(path.dirname(target))));
    return run;
  }
  function projectDirectories(projectId: string) {
    return roots().map((base) => path.join(base, projectHash(projectId)));
  }
  function list(projectId: string): TaskRun[] {
    const ids = new Set(
      (locations?.entries() ?? [])
        .filter(([key]) => key.startsWith(projectHash(projectId) + path.sep))
        .map(([key]) => path.basename(key)),
    );
    for (const directory of projectDirectories(projectId)) {
      if (!operations.existsSync(directory)) continue;
      for (const entry of operations.readdirSync(directory, {
        withFileTypes: true,
      }))
        if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
          ids.add(entry.name);
    }
    return [...ids]
      .map((id) => read(projectId, id))
      .filter((run): run is TaskRun => !!run)
      .sort((a, b) => b.createdAt - a.createdAt || b.revision - a.revision);
  }
  function projectDirectoriesAll() {
    const directories: string[] = [];
    for (const base of roots()) {
      if (!operations.existsSync(base)) continue;
      for (const project of operations.readdirSync(base, {
        withFileTypes: true,
      }))
        if (project.isDirectory() && /^[a-f0-9]{64}$/.test(project.name))
          directories.push(path.join(base, project.name));
    }
    return directories;
  }
  return {
    get root() {
      return root();
    },
    roots,
    locations,
    owns: (target: string) => roots().some((base) => within(base, target)),
    projectPath,
    projectDirectories,
    projectDirectoriesAll,
    runPath,
    list,
    read,
    write(run: TaskRun) {
      assertTaskStorageWritable();
      validate(run);
      const target = runPath(run.projectId, run.runId);
      const pinned = locations?.pinned(keyFor(run.projectId, run.runId));
      if (pinned && !operations.existsSync(target))
        throw new Error(`TASK_STORAGE_UNAVAILABLE: ${target}`);
      if (!operations.existsSync(target)) {
        // Explicitly submitting the same project identity starts a live lineage.
        // A retirement marker from its prior deletion must not hide the new run.
        for (const directory of projectDirectories(run.projectId))
          operations.rmSync(path.join(directory, 'retired.json'), {
            force: true,
          });
      }
      writeJson(target, run);
      locations?.pin(
        keyFor(run.projectId, run.runId),
        path.dirname(path.dirname(path.dirname(target))),
      );
    },
    readDraft(projectId: string): TaskDraft | null {
      const drafts = projectDirectories(projectId)
        .map((dir) => readJson<TaskDraft>(path.join(dir, 'draft.json')))
        .filter((draft): draft is TaskDraft => !!draft);
      return drafts.sort((a, b) => b.revision - a.revision)[0] ?? null;
    },
    prepareRetirement(projectIds: string[]) {
      assertTaskStorageWritable();
      const marked: string[] = [];
      const rollback = () => {
        for (const target of marked) operations.rmSync(target, { force: true });
      };
      try {
        for (const projectId of projectIds) {
          if (!list(projectId).length) continue;
          for (const directory of projectDirectories(projectId)) {
            if (!operations.existsSync(directory)) continue;
            const target = path.join(directory, 'retired.json');
            if (operations.existsSync(target)) continue;
            writeJson(target, { projectId, retiredAt: Date.now() });
            marked.push(target);
          }
        }
        return { commit() {}, rollback };
      } catch (error) {
        rollback();
        throw error;
      }
    },
    reconcileRetirements(projectIds: string[]) {
      for (const projectId of projectIds)
        for (const directory of projectDirectories(projectId))
          operations.rmSync(path.join(directory, 'retired.json'), {
            force: true,
          });
    },
    writeDraft(projectId: string, draft: TaskDraft) {
      assertTaskStorageWritable();
      writeJson(path.join(projectPath(projectId), 'draft.json'), draft);
    },
    all(
      options: { skipUnsupported?: boolean; includeRetired?: boolean } = {},
    ): TaskRun[] {
      const runs = new Map<string, TaskRun>();
      const directories = projectDirectoriesAll();
      const retired = new Set(
        directories
          .filter((dir) =>
            operations.existsSync(path.join(dir, 'retired.json')),
          )
          .map((dir) => path.basename(dir)),
      );
      for (const directory of directories) {
        if (!options.includeRetired && retired.has(path.basename(directory)))
          continue;
        for (const entry of operations.readdirSync(directory, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name))
            continue;
          const key = path.join(path.basename(directory), entry.name);
          const base = path.dirname(directory);
          if (locations?.pinned(key) && locations.pinned(key) !== base)
            continue;
          const value = readJson<TaskRun>(
            path.join(directory, entry.name, 'manifest.json'),
          );
          if (!value) continue;
          if (
            options.skipUnsupported &&
            value.schemaVersion !== TASK_RUN_SCHEMA_VERSION
          )
            continue;
          if (keyFor(value.projectId, value.runId) !== key)
            throw new Error('TASK_STORAGE_ID_MISMATCH');
          if (runs.has(key)) throw new Error('TASK_STORAGE_CONFLICT');
          runs.set(key, validate(value)!);
        }
      }
      // Pin only after the entire scan has checked for conflicting copies.
      for (const [key, run] of runs)
        if (!locations?.pinned(key))
          locations?.pin(
            key,
            path.dirname(
              path.dirname(path.dirname(runPath(run.projectId, run.runId))),
            ),
          );
      return [...runs.values()];
    },
  };
}
export type TaskRunStore = ReturnType<typeof createTaskRunStore>;
