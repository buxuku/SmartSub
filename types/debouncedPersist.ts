export interface DebouncedPersist<T> {
  schedule(value: T): void;
  flush(): void;
  cancel(): void;
}

/**
 * Last-write-wins debounce with an explicit lifecycle flush.
 *
 * UI owners call flush() before unmount so the final pending edit is not lost;
 * cancel() is reserved for an explicit replacement such as "restore factory".
 */
export function createDebouncedPersist<T>(
  persist: (value: T) => void | Promise<void>,
  delayMs: number,
): DebouncedPersist<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | undefined;
  let hasPending = false;

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const commit = () => {
    clearTimer();
    if (!hasPending) return;
    const value = pending as T;
    pending = undefined;
    hasPending = false;
    void persist(value);
  };

  return {
    schedule(value: T) {
      pending = value;
      hasPending = true;
      clearTimer();
      timer = setTimeout(commit, delayMs);
    },
    flush: commit,
    cancel() {
      clearTimer();
      pending = undefined;
      hasPending = false;
    },
  };
}
