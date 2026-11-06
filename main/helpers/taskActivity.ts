import type { ActivityDetail, TaskActivity } from '../../types/taskActivity';

type Send = (activity: TaskActivity) => void;
export interface ActivityScope {
  update(detail: ActivityDetail): void;
  finish(status?: 'done' | 'error' | 'cancelled'): void;
}

/** One reporter per file execution. Scopes reject callbacks from finished stages. */
export class TaskActivityReporter {
  private snapshot: TaskActivity;
  private epoch = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private sentAt = 0;
  private readonly onAbort = () => {
    if (this.snapshot.status !== 'running') return;
    this.snapshot = { ...this.snapshot, status: 'cancelling' };
    this.publish(true);
  };

  constructor(
    run: number,
    private send: Send,
    private signal?: AbortSignal,
  ) {
    const now = Date.now();
    this.snapshot = {
      run,
      sequence: 0,
      stage: null,
      phase: 'idle',
      status: 'running',
      startedAt: now,
      phaseStartedAt: now,
      updatedAt: now,
    };
    signal?.addEventListener('abort', this.onAbort, { once: true });
    this.publish(true);
  }

  start(
    stage: TaskActivity['stage'],
    phase: ActivityDetail['phase'],
  ): ActivityScope {
    const epoch = ++this.epoch;
    const now = Date.now();
    this.snapshot = {
      run: this.snapshot.run,
      sequence: this.snapshot.sequence,
      stage,
      phase,
      status: this.signal?.aborted ? 'cancelling' : 'running',
      startedAt: now,
      phaseStartedAt: now,
      updatedAt: now,
    };
    this.publish(true);
    const current = () => !this.closed && epoch === this.epoch;
    return {
      update: (detail) => {
        if (!current() || this.signal?.aborted) return;
        const changed = detail.phase !== this.snapshot.phase;
        const states = (units: ActivityDetail['units']) =>
          JSON.stringify(
            units?.map(({ id, phase, retry }) => [id, phase, retry]),
          );
        const unitsChanged =
          detail.units !== undefined &&
          states(detail.units) !== states(this.snapshot.units);
        this.snapshot = {
          ...this.snapshot,
          ...detail,
          updatedAt: Date.now(),
          phaseStartedAt: changed ? Date.now() : this.snapshot.phaseStartedAt,
        };
        this.publish(changed || unitsChanged);
      },
      finish: (status = 'done') => {
        if (!current()) return;
        ++this.epoch;
        this.snapshot = {
          ...this.snapshot,
          status,
          units: [],
          updatedAt: Date.now(),
        };
        this.publish(true);
      },
    };
  }

  close() {
    if (this.closed) return;
    if (
      this.snapshot.status === 'running' ||
      this.snapshot.status === 'cancelling'
    ) {
      this.snapshot = {
        ...this.snapshot,
        units: [],
        updatedAt: Date.now(),
        status: this.signal?.aborted ? 'cancelled' : 'done',
      };
    }
    this.publish(true);
    this.closed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
  }

  private publish(immediate: boolean) {
    if (this.closed) return;
    if (!immediate && Date.now() - this.sentAt < 250) {
      if (!this.timer)
        this.timer = setTimeout(
          () => this.publish(true),
          250 - (Date.now() - this.sentAt),
        );
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.sentAt = Date.now();
    this.snapshot = { ...this.snapshot, sequence: this.snapshot.sequence + 1 };
    this.send(structuredClone(this.snapshot));
  }
}
