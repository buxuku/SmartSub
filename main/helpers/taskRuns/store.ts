import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TASK_RUN_SCHEMA_VERSION, type TaskRun, type TaskDraft } from '../../../types/taskRun';

export function createTaskRunStore(root: string, operations: typeof fs = fs) {
  const projectPath = (projectId: string) => path.join(root, createHash('sha256').update(projectId).digest('hex'));
  const runPath = (projectId: string, runId: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('TASK_RUN_ID_INVALID');
    return path.join(projectPath(projectId), runId, 'manifest.json');
  };
  function readJson<T>(target: string): T | null {
    try { return JSON.parse(operations.readFileSync(target, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  function validate(run: TaskRun | null) {
    if (run && run.schemaVersion !== TASK_RUN_SCHEMA_VERSION) throw new Error('TASK_RUN_VERSION_UNSUPPORTED');
    return run;
  }
  function writeJson(target: string, value: unknown) {
    operations.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = operations.openSync(temp, 'wx', 0o600);
      operations.writeFileSync(fd, JSON.stringify(value));
      operations.fsyncSync(fd);
      operations.closeSync(fd); fd = undefined;
      operations.renameSync(temp, target);
    } finally {
      if (fd !== undefined) operations.closeSync(fd);
      if (operations.existsSync(temp)) operations.unlinkSync(temp);
    }
  }
  function list(projectId: string): TaskRun[] {
    const directory = projectPath(projectId);
    if (!operations.existsSync(directory)) return [];
    return operations.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => validate(readJson<TaskRun>(runPath(projectId, entry.name)))).filter((run): run is TaskRun => !!run).sort((a, b) => b.createdAt - a.createdAt || b.revision - a.revision);
  }
  return {
    root, projectPath, runPath, list,
    read: (projectId: string, runId: string) => validate(readJson<TaskRun>(runPath(projectId, runId))),
    write(run: TaskRun) { validate(run); writeJson(runPath(run.projectId, run.runId), run); },
    readDraft: (projectId: string) => readJson<TaskDraft>(path.join(projectPath(projectId), 'draft.json')),
    writeDraft(projectId: string, draft: TaskDraft) { writeJson(path.join(projectPath(projectId), 'draft.json'), draft); },
    all(): TaskRun[] {
      if (!operations.existsSync(root)) return [];
      const runs: TaskRun[] = [];
      for (const project of operations.readdirSync(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        for (const entry of operations.readdirSync(path.join(root, project.name), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const run = validate(readJson<TaskRun>(path.join(root, project.name, entry.name, 'manifest.json')));
          if (run) runs.push(run);
        }
      }
      return runs;
    },
  };
}
export type TaskRunStore = ReturnType<typeof createTaskRunStore>;
