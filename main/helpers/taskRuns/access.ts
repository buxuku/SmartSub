import { isRunLocked } from '../../../types/taskRun';
import type { TaskRunService } from './service';
import type { TaskSubmission } from '../../../types/taskSubmission';
import type { acceptManagedTask } from './runtime';

let resolveService: (() => TaskRunService) | undefined;
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
  const run = taskRunService()?.get(projectId);
  if (isRunLocked(run)) throw new Error('TASK_CONFIG_BUSY');
  if (run) throw new Error('TASK_RUN_READ_ONLY_USE_DRAFT');
}
