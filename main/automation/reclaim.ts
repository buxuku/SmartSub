import fs from 'node:fs';
import path from 'node:path';
import { removeTree, type ReclaimReport } from '../helpers/taskRuns/cleanup';
import { within } from '../helpers/taskRuns/storageIO';

// The names the job store accepts for receipts, so that no id can reach outside its folders.
const JOB_ID = /^[\w-]+$/;

export interface AutomationReclaimInput {
  /** Ids of the deleted work items and of automation jobs deleted on their own. */
  ids: readonly string[];
  jobs: ReadonlyArray<{ id: string; projectId?: string }>;
  /** True for a job that has not ended yet, or that waits for a review. */
  isBusy(jobId: string): boolean;
  /** Where a job's outputs go when its caller does not choose a folder. */
  outputDirectory(jobId: string): string;
  receiptPath(jobId: string): string;
  /** Forgets a job and removes its receipt. */
  discard(jobId: string): void;
  /**
   * Tests whether a record that remains still points at a path. References found in the
   * files that `ignore` selects do not count.
   */
  protector(
    ignore: (file: string) => boolean,
  ): Promise<(target: string) => boolean>;
}

/**
 * Removes what automation keeps for deleted tasks: the receipts of their jobs and the
 * outputs those jobs wrote into the app's own outputs location. A folder the caller
 * chose is never looked at, and neither is one that a remaining record still uses.
 *
 * Uncertain means retained: a job that is still going, or waits for a review, keeps its
 * receipt and the outputs of its task; a folder that cannot be removed keeps the receipt
 * of the job that owns it, so the deletion can be repeated.
 */
export async function reclaimAutomationJobs(
  input: AutomationReclaimInput,
): Promise<ReclaimReport> {
  const report: ReclaimReport = {
    files: 0,
    bytes: 0,
    errors: [],
    retained: [],
  };
  const wanted = new Set(input.ids);
  const selected = input.jobs.filter(
    (job) =>
      JOB_ID.test(job.id) &&
      (wanted.has(job.id) ||
        (job.projectId !== undefined && wanted.has(job.projectId))),
  );
  if (!selected.length) return report;
  try {
    // Any job of a task can write into its outputs, so one that is going holds them all.
    const holding = new Set<string>();
    for (const job of input.jobs)
      if (input.isBusy(job.id))
        for (const id of [job.id, job.projectId]) if (id) holding.add(id);
    const finished = selected.filter((job) => {
      if (!input.isBusy(job.id)) return true;
      report.retained.push(input.receiptPath(job.id));
      return false;
    });

    // Receipts stay when the outputs they describe could not be dealt with.
    const unresolved = new Set<string>();
    const folders = new Map<string, string>();
    const ids = new Set(finished.flatMap((job) => [job.id, job.projectId]));
    for (const id of ids) {
      if (!id || !JOB_ID.test(id)) continue;
      const directory = input.outputDirectory(id);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (holding.has(id)) {
        unresolved.add(id);
        report.retained.push(directory);
      } else if (!stat.isDirectory()) {
        // A link or a stray file is not something the app made for the job.
        report.retained.push(directory);
      } else folders.set(id, directory);
    }

    if (folders.size) {
      const receipts = new Set(
        finished.map((job) => path.resolve(input.receiptPath(job.id))),
      );
      const directories = [...folders.values()];
      // The receipts and the files inside the folders mention the folders themselves.
      const ignore = (file: string) =>
        receipts.has(path.resolve(file)) ||
        directories.some((directory) => within(directory, file));
      try {
        const isProtected = await input.protector(ignore);
        for (const [id, directory] of folders) {
          if (isProtected(directory)) {
            report.retained.push(directory);
            continue;
          }
          try {
            await removeTree(directory, report);
          } catch (error) {
            unresolved.add(id);
            report.errors.push(String(error));
          }
        }
      } catch (error) {
        for (const id of folders.keys()) unresolved.add(id);
        report.errors.push(String(error));
      }
    }

    for (const job of finished) {
      if (unresolved.has(job.id)) continue;
      try {
        const size = await fs.promises.stat(input.receiptPath(job.id)).then(
          (stat) => stat.size,
          () => undefined,
        );
        input.discard(job.id);
        if (size !== undefined) {
          report.files += 1;
          report.bytes += size;
        }
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
