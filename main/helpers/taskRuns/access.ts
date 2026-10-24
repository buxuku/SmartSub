import { isRunLocked } from '../../../types/taskRun';
import type { TaskRunService } from './service';

let resolveService: (() => TaskRunService) | undefined;
export function setTaskRunServiceResolver(resolve: () => TaskRunService) { resolveService = resolve; }
export function taskRunService(): TaskRunService | undefined { return resolveService?.(); }
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
