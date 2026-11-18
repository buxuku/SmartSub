import path from 'node:path';
import { within } from './storageIO';

// Pure decisions for what else a deleted task leaves behind. Electron free: the host
// (storageRuntime) supplies the stores and the reference sets.

const DRAFT_KEY_PREFIX = 'smartsub_proofread_draft_v1:';

/** Entries named by document identity: proofread recovery drafts, quality reviews. */
export interface KeyedEntryStore {
  list(): string[];
  remove(key: string): void;
}

/** What deleting the tasks took away. Entries that only describe it have no use left. */
export interface DeletedTaskData {
  /** Managed proofread sidecars this deletion reclaimed. */
  sidecars: readonly string[];
  /** Run storage of the deleted tasks that is about to be reclaimed. */
  directories: readonly string[];
}

export interface EntryReclaimReport {
  /** Entries removed across all stores. */
  removed: number;
  errors: string[];
}

/**
 * The absolute document paths a draft key is built from (empty slots dropped), or null
 * when the key is not one the editor writes. Unknown shapes must never match anything.
 */
export function draftKeyPaths(key: string): string[] | null {
  if (typeof key !== 'string' || !key.startsWith(DRAFT_KEY_PREFIX)) return null;
  try {
    const parts: unknown = JSON.parse(key.slice(DRAFT_KEY_PREFIX.length));
    if (!Array.isArray(parts)) return null;
    const paths: string[] = [];
    for (const part of parts) {
      if (typeof part !== 'string') return null;
      if (!part) continue;
      if (!path.isAbsolute(part)) return null;
      paths.push(path.resolve(part));
    }
    return paths;
  } catch {
    return null;
  }
}

/**
 * Removes the saved drafts and quality reviews that belong to deleted tasks, so they
 * stop pinning the task storage and stop occupying disk space. An entry goes when
 *  - its managed sidecar was reclaimed: the document is gone whatever else the key
 *    names, or
 *  - it names files inside the deleted task storage and none of those is still used
 *    by a remaining record (`claimed`), e.g. another task proofreading the same file.
 * Anything else stays, including entries whose identity cannot be read and drafts of
 * documents that live next to the user's media.
 *
 * `claimed` is only asked when a decision needs it, because it scans every record.
 */
export async function reclaimDeletedDrafts(
  stores: readonly KeyedEntryStore[],
  deleted: DeletedTaskData,
  claimed: () => Promise<(target: string) => boolean>,
): Promise<EntryReclaimReport> {
  const report: EntryReclaimReport = { removed: 0, errors: [] };
  // Nothing was taken away, so no entry can describe it: skip reading them all.
  if (!deleted.sidecars.length && !deleted.directories.length) return report;
  const sidecars = deleted.sidecars.map((file) => path.resolve(file));
  const isSidecar = (file: string) =>
    sidecars.some((sidecar) => path.relative(sidecar, file) === '');
  const isStorage = (file: string) =>
    deleted.directories.some((directory) => within(directory, file));
  const scan = () =>
    stores.flatMap((store) => {
      try {
        return store.list().flatMap((key) => {
          const files = draftKeyPaths(key);
          if (!files) return [];
          const sidecar = files.some(isSidecar);
          const inside = files.filter(isStorage);
          return sidecar || inside.length
            ? [{ store, key, sidecar, inside }]
            : [];
        });
      } catch (error) {
        report.errors.push(String(error));
        return [];
      }
    });
  try {
    let entries = scan();
    let isClaimed: (target: string) => boolean = () => false;
    if (entries.some((entry) => !entry.sidecar)) {
      isClaimed = await claimed();
      // Collecting the references took a while: decide on what is on disk now.
      entries = scan();
    }
    for (const entry of entries) {
      if (!entry.sidecar && entry.inside.some(isClaimed)) continue;
      try {
        entry.store.remove(entry.key);
        report.removed += 1;
      } catch (error) {
        report.errors.push(String(error));
      }
    }
  } catch (error) {
    report.errors.push(String(error));
  }
  report.errors = [...new Set(report.errors)];
  return report;
}
