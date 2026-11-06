import type {
  ActivityObserver,
  ActivityUnit,
} from '../../../types/taskActivity';

/** Observes the existing scheduler; received batches are distinct from saved batches. */
export class TranslationActivity {
  private units = new Map<number, ActivityUnit>();
  private completed = 0;
  private savedBatches = 0;
  private failedCues = 0;
  private closed = false;

  constructor(
    private total: number,
    private observe?: ActivityObserver,
    private signal?: AbortSignal,
  ) {
    this.publish();
  }

  update(id: number, detail: Omit<ActivityUnit, 'id' | 'startedAt'>) {
    if (this.closed || this.signal?.aborted) return;
    this.units.set(id, {
      id,
      startedAt: this.units.get(id)?.startedAt ?? Date.now(),
      ...detail,
    });
    this.publish();
  }

  received(id: number, failed: number) {
    this.units.delete(id);
    this.completed++;
    this.failedCues += failed;
    this.publish();
  }

  saved(id: number) {
    this.units.delete(id);
    this.savedBatches++;
    this.publish();
  }

  close() {
    this.closed = true;
  }

  private publish() {
    if (this.closed || this.signal?.aborted) return;
    const units = [...this.units.values()];
    this.observe?.({
      phase: units.length === 1 ? units[0].phase : 'translating',
      completed: this.completed,
      total: this.total,
      unit: 'batches',
      savedBatches: this.savedBatches,
      failedCues: this.failedCues,
      units,
    });
  }
}
