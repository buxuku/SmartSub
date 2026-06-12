import { AsyncLocalStorage } from 'async_hooks';

export interface TaskRunContext {
  projectId?: string;
  fileUuid?: string;
  /** 取消信号：翻译批次边界与阶段边界检查 */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<TaskRunContext>();

/** 在任务上下文中执行：logMessage 自动打 projectId 标，取消检查可感知 signal */
export function runWithTaskContext<T>(
  context: TaskRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function getTaskContext(): TaskRunContext | undefined {
  return storage.getStore();
}

const CANCEL_MESSAGE = 'TASK_CANCELLED';

export class TaskCancelledError extends Error {
  constructor() {
    super(CANCEL_MESSAGE);
    this.name = 'TaskCancelledError';
  }
}

export function isTaskCancelledError(error: unknown): boolean {
  return (
    error instanceof TaskCancelledError ||
    (error instanceof Error && error.message === CANCEL_MESSAGE)
  );
}

export function isTaskCancelled(): boolean {
  return Boolean(storage.getStore()?.signal?.aborted);
}

export function throwIfTaskCancelled(): void {
  if (isTaskCancelled()) throw new TaskCancelledError();
}
