export type ToolboxQueueStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled';

export interface ToolboxQueueInput {
  filePath: string;
}

export interface ToolboxQueueResult {
  success: boolean;
  error?: string;
}

export interface ToolboxQueueItem<I, R> {
  id: string;
  input: I;
  filePath: string;
  fileName: string;
  status: ToolboxQueueStatus;
  progress?: number;
  result?: R;
  error?: string;
}

export interface ToolboxQueueSnapshot<I, R> {
  items: ToolboxQueueItem<I, R>[];
  running: boolean;
  cancelling: boolean;
  error?: string;
}

export interface ToolboxQueueRunner<I, R> {
  execute: (
    input: I,
    jobId: string,
    signal: AbortSignal,
    previousResult?: R,
  ) => Promise<R>;
  cancel?: (jobId: string) => Promise<unknown>;
  failureMessage: string;
}

/** One live job per queue. Cancellation holds the lock until that job settles. */
export class ToolboxQueue<
  I extends ToolboxQueueInput,
  R extends ToolboxQueueResult,
> {
  private snapshot: ToolboxQueueSnapshot<I, R> = {
    items: [],
    running: false,
    cancelling: false,
  };
  private listeners = new Set<() => void>();
  private active?: {
    itemId: string;
    jobId: string;
    abort: AbortController;
    cancel?: ToolboxQueueRunner<I, R>['cancel'];
  };
  private stopRequested = false;

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<ToolboxQueueSnapshot<I, R>>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private patchItem(id: string, patch: Partial<ToolboxQueueItem<I, R>>) {
    this.publish({
      items: this.snapshot.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
  }

  add(inputs: I[]) {
    if (this.snapshot.running) return;
    const existing = new Set(this.snapshot.items.map((item) => item.filePath));
    const added: ToolboxQueueItem<I, R>[] = [];
    for (const input of inputs) {
      if (!input.filePath || existing.has(input.filePath)) continue;
      existing.add(input.filePath);
      added.push({
        id: crypto.randomUUID(),
        input,
        filePath: input.filePath,
        fileName: input.filePath.split(/[/\\]/).pop() || input.filePath,
        status: 'pending',
      });
    }
    this.publish({ items: [...this.snapshot.items, ...added] });
  }

  updateInput(id: string, input: I) {
    if (!this.snapshot.running)
      this.patchItem(id, {
        input,
        status: 'pending',
        result: undefined,
        error: undefined,
        progress: undefined,
      });
  }

  remove(id: string) {
    if (!this.snapshot.running)
      this.publish({
        items: this.snapshot.items.filter((item) => item.id !== id),
      });
  }

  clear() {
    if (!this.snapshot.running) this.publish({ items: [], error: undefined });
  }

  progress(jobId: string, percent: number) {
    if (this.active?.jobId !== jobId || !Number.isFinite(percent)) return;
    this.patchItem(this.active.itemId, {
      progress: Math.max(0, Math.min(99, percent)),
    });
  }

  async run(runner: ToolboxQueueRunner<I, R>, retryId?: string) {
    if (this.snapshot.running) return;
    const pending = this.snapshot.items.filter((item) =>
      retryId
        ? item.id === retryId &&
          (item.status === 'error' || item.status === 'cancelled')
        : item.status === 'pending' || item.status === 'cancelled',
    );
    if (!pending.length) return;
    this.stopRequested = false;
    this.publish({ running: true, cancelling: false, error: undefined });
    try {
      for (const item of pending) {
        if (this.stopRequested) break;
        const jobId = `toolbox_${crypto.randomUUID()}`;
        const abort = new AbortController();
        this.active = { itemId: item.id, jobId, abort, cancel: runner.cancel };
        this.patchItem(item.id, {
          status: 'running',
          error: undefined,
          progress: undefined,
        });
        try {
          const result = await runner.execute(
            item.input,
            jobId,
            abort.signal,
            item.result,
          );
          if (result?.success === true) {
            this.patchItem(item.id, { status: 'done', progress: 100, result });
          } else {
            this.patchItem(item.id, {
              status: this.stopRequested ? 'cancelled' : 'error',
              progress: undefined,
              result,
              error: result?.error || runner.failureMessage,
            });
          }
        } catch (error) {
          this.patchItem(item.id, {
            status: this.stopRequested ? 'cancelled' : 'error',
            progress: undefined,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.active = undefined;
        }
      }
    } finally {
      this.publish({ running: false, cancelling: false });
    }
  }

  async cancel() {
    if (!this.snapshot.running || this.stopRequested) return;
    this.stopRequested = true;
    this.active?.abort.abort();
    this.publish({ cancelling: true });
    try {
      if (this.active?.cancel) await this.active.cancel(this.active.jobId);
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
