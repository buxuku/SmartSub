import {
  isRunLocked,
  hasPendingTaskReview,
  type TaskRun,
  type FileRun,
} from '../../../types/taskRun';
import path from 'node:path';
import type { TaskRunService } from './service';
import type { TaskSubmission } from '../../../types/taskSubmission';
import type { acceptManagedTask } from './runtime';

let resolveService: (() => TaskRunService) | undefined;
const resultWrites = new Set<string>();
const editKey = (target: string) => path.resolve(target).toLowerCase();

/** Only the file stopped at a review gate becomes editable during a live batch. */
export function assertTaskRunResultEditable(run: TaskRun, file?: FileRun) {
  if (run.legacy) throw new Error('TASK_HISTORY_READ_ONLY');
  if (!isRunLocked(run) || run.status === 'waiting_review') return;
  if (
    file &&
    hasPendingTaskReview({ ...run, files: [file] }) &&
    !Object.values(file.stages).some((stage) => stage.status === 'running')
  )
    return;
  throw new Error('TASK_RESULT_BUSY');
}

export function assertTaskResultsSaved(paths: Array<string | undefined>) {
  if (paths.some((target) => target && resultWrites.has(editKey(target))))
    throw new Error('TASK_RESULT_SAVE_IN_PROGRESS');
}
export function beginTaskResultWrite(target: string) {
  assertTaskResultsSaved([target]);
  const key = editKey(target);
  resultWrites.add(key);
  return () => {
    resultWrites.delete(key);
  };
}
let legacyBusy: (projectId: string) => boolean = () => false;
export function setLegacyTaskBusyResolver(resolve: typeof legacyBusy) {
  legacyBusy = resolve;
}
export const isLegacyTaskBusy = (projectId: string) => legacyBusy(projectId);
let accept: typeof acceptManagedTask | undefined;
let assertEdit:
  | ((input: { path?: string; sessionId?: string }) => void)
  | undefined;
let deleteRuns:
  | ((ids: string[]) => { commit(): void; rollback(): void })
  | undefined;
export function setTaskRunDeletion(handler: typeof deleteRuns) {
  deleteRuns = handler;
}
export function retireTaskRuns(ids: string[]) {
  return deleteRuns?.(ids);
}
export function setTaskRunEditGuard(guard: typeof assertEdit) {
  assertEdit = guard;
}
export function assertTaskRunEditable(input: {
  path?: string;
  sessionId?: string;
}) {
  assertEdit?.(input);
}
export function setManagedTaskAcceptance(handler: typeof acceptManagedTask) {
  accept = handler;
}
export function acceptTaskRun(input: TaskSubmission) {
  return accept?.(input);
}
export function setTaskRunServiceResolver(resolve: () => TaskRunService) {
  resolveService = resolve;
}
export function taskRunService(): TaskRunService | undefined {
  return resolveService?.();
}
export function requireTaskRunService(): TaskRunService {
  const service = taskRunService();
  if (!service) throw new Error('TASK_RUNTIME_NOT_INITIALIZED');
  return service;
}
export function assertLegacyTaskWriteAllowed(projectId: string): void {
  if (legacyBusy(projectId)) throw new Error('TASK_CONFIG_BUSY');
  const run = taskRunService()?.get(projectId);
  if (isRunLocked(run)) throw new Error('TASK_CONFIG_BUSY');
  if (run) throw new Error('TASK_RUN_READ_ONLY_USE_DRAFT');
}
