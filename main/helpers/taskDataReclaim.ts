import type { WorkItem } from '../../types/workItem';
import type { ReclaimReport } from './taskRuns/cleanup';

/** What a finished work-item deletion hands over to the data reclaimer. */
export interface TaskDataReclaimRequest {
  /** Work items that were just removed from the persisted index. */
  items: WorkItem[];
  /** Managed proofread sidecars the deletion already removed from disk. */
  proofreadFiles: string[];
  /** Automation jobs that were deleted without a work item of their own. */
  jobIds?: string[];
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
  if (!current || (!request.items.length && !request.jobIds?.length)) return;
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

/** What the reclaimer lets automation decide about the data it keeps. */
export interface AutomationReclaimScope {
  /** Ids of the deleted work items and of automation jobs deleted on their own. */
  ids: string[];
  /**
   * Tests whether a record that remains still points at a path. References found in the
   * files that `ignore` selects do not count: the data being removed must not keep itself.
   */
  protector(
    ignore: (file: string) => boolean,
  ): Promise<(target: string) => boolean>;
}

export type AutomationReclaimer = (
  scope: AutomationReclaimScope,
) => Promise<ReclaimReport>;

// Automation starts after the task storage does, so it registers itself separately.
let automationReclaimer: AutomationReclaimer | undefined;

export function setAutomationReclaimer(next: AutomationReclaimer | undefined) {
  automationReclaimer = next;
}

/**
 * Lets automation remove the receipts and outputs of the deleted tasks. It reports what
 * it did and never throws; without automation there is nothing to do.
 */
export async function reclaimAutomationData(
  scope: AutomationReclaimScope,
): Promise<ReclaimReport> {
  const report = (errors: string[] = []): ReclaimReport => ({
    files: 0,
    bytes: 0,
    errors,
    retained: [],
  });
  if (!automationReclaimer || !scope.ids.length) return report();
  try {
    return await automationReclaimer(scope);
  } catch (error) {
    return report([String(error)]);
  }
}
