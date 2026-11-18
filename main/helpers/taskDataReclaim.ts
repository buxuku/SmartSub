import type { WorkItem } from '../../types/workItem';

/** What a finished work-item deletion hands over to the data reclaimer. */
export interface TaskDataReclaimRequest {
  /** Work items that were just removed from the persisted index. */
  items: WorkItem[];
  /** Managed proofread sidecars the deletion already removed from disk. */
  proofreadFiles: string[];
}

export type TaskDataReclaimer = (
  request: TaskDataReclaimRequest,
) => Promise<void>;

// The implementation needs Electron and the task storage; hosts register it at startup.
// Without one (unit tests, headless tools) deleting a task simply reclaims nothing extra.
let reclaimer: TaskDataReclaimer | undefined;
const pending = new Set<Promise<void>>();

export function setTaskDataReclaimer(next: TaskDataReclaimer | undefined) {
  reclaimer = next;
}

/**
 * Starts reclaiming what the deleted items left behind and tracks it. This never throws
 * and never rejects: a cleanup problem must not turn a committed deletion into a failure.
 * Anything left behind is collected by the startup collector or a manual cache cleanup.
 */
export function startTaskDataReclaim(request: TaskDataReclaimRequest): void {
  const current = reclaimer;
  if (!current || !request.items.length) return;
  // Start on a microtask so the rest of the deletion commit finishes first.
  const run: Promise<void> = Promise.resolve()
    .then(() => current(request))
    .catch((error) => {
      console.warn('Task data cleanup failed', error);
    })
    .finally(() => {
      pending.delete(run);
    });
  pending.add(run);
}

/** Resolves once every reclamation started so far has finished. */
export async function settleTaskDataReclaim(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
