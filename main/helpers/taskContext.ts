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

export function getTaskSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

export function throwIfSignalCancelled(signal?: AbortSignal): void {
  if (signal?.aborted || isTaskCancelled()) throw new TaskCancelledError();
}

export function waitForTaskDelay(
  ms: number,
  signal: AbortSignal | undefined = getTaskSignal(),
): Promise<void> {
  throwIfSignalCancelled(signal);
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new TaskCancelledError());
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** whisper addon 因 AbortSignal 中断时抛出的错误（与 TaskCancelledError 统一处理） */
export function isWhisperAbortError(error: unknown): boolean {
  if (isTaskCancelledError(error)) return true;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true;
    const msg = error.message.toLowerCase();
    if (
      msg.includes('aborted') ||
      msg.includes('abort') ||
      msg.includes('cancelled') ||
      msg.includes('canceled')
    ) {
      return true;
    }
  }
  return false;
}

/** addon 正常 resolve 但 cancelled:true（非 throw） */
export function isWhisperCancelledResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { cancelled?: boolean }).cancelled === true
  );
}
