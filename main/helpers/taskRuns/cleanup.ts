import fs from 'node:fs';
import path from 'node:path';
import type { TaskRunStore } from './store';
import { TASK_RUN_SCHEMA_VERSION, isRunLocked } from '../../../types/taskRun';
import { readJson, referencedPaths, walkFiles, within } from './storageIO';

export interface CleanupReport {
  files: number;
  bytes: number;
  errors: string[];
}
export interface ReclaimReport extends CleanupReport {
  /** Retired data kept because a remaining record still references it. */
  retained: string[];
}
export const liveWorkspaces = new Set<string>();
const media = /\.(wav|mp3|m4a|flac|ogg|opus|aac|mp4|mkv|webm|mov)$/i;

/** A target is protected when it is, or contains, any referenced path. */
function createProtector(references: Set<string>) {
  return (target: string) =>
    [...references].some(
      (ref) => path.relative(target, ref) === '' || within(target, ref),
    );
}

/** Rejects junctions before the recursive removal, then tallies what was reclaimed. */
async function removeTree(target: string, report: CleanupReport) {
  const files = await walkFiles(target);
  const bytes = (
    await Promise.all(files.map((file) => fs.promises.stat(file)))
  ).reduce((sum, stat) => sum + stat.size, 0);
  await fs.promises.rm(target, { recursive: true, force: true });
  report.files += files.length;
  report.bytes += bytes;
}

async function expandReferences(values: unknown[]) {
  const references = referencedPaths(values);
  const visited = new Set<string>();
  for (const target of references) {
    if (!target.endsWith('.json') || visited.has(target)) continue;
    visited.add(target);
    const value = readJson(target);
    if (value) referencedPaths(value, references);
  }
  return references;
}

export async function cleanupWorkspace(directory: string, values: unknown[]) {
  if (!fs.existsSync(directory) || liveWorkspaces.has(directory)) return;
  const refs = await expandReferences(values);
  if ([...refs].some((ref) => ref === directory || within(directory, ref)))
    return;
  await walkFiles(directory); // reject junctions before recursive removal
  await fs.promises.rm(directory, { recursive: true, force: true });
}

/** Invoked after recovery or explicitly while idle; uncertain ownership means retain. */
export async function collectTaskRunGarbage(
  store: TaskRunStore,
  options: { references: unknown[] },
): Promise<CleanupReport> {
  const report: CleanupReport = { files: 0, bytes: 0, errors: [] };
  try {
    for (const [key, root] of store.locations?.entries() ?? [])
      if (!fs.existsSync(path.join(root, key, 'manifest.json')))
        throw new Error(`TASK_STORAGE_UNAVAILABLE: ${root}`);
    const runs = store.all();
    const references = await expandReferences([runs, ...options.references]);
    const busy = runs
      .filter(isRunLocked)
      .map((run) => path.dirname(store.runPath(run.projectId, run.runId)));
    const protectedPath = createProtector(references);
    const remove = (target: string) => removeTree(target, report);
    // Read persistent JSON before deleting anything: old versions stored references
    // inside proofread metadata, not just in manifest projections.
    const inventories = new Map<string, string[]>();
    for (const directory of store.projectDirectoriesAll()) {
      const files = await walkFiles(directory);
      inventories.set(directory, files);
      // Unknown/corrupt metadata prevents deletion, including in retired runs.
      for (const file of files)
        if (file.endsWith('.json')) {
          const value = readJson<any>(file);
          if (
            path.basename(file) === 'manifest.json' &&
            value?.schemaVersion !== 1
          )
            throw new Error('TASK_RUN_VERSION_UNSUPPORTED');
        }
    }
    let previousSize = -1;
    while (previousSize !== references.size) {
      previousSize = references.size;
      for (const [directory, files] of inventories) {
        if (
          fs.existsSync(path.join(directory, 'retired.json')) &&
          !protectedPath(directory)
        )
          continue;
        for (const file of files)
          if (file.endsWith('.json')) {
            if (
              !file.split(path.sep).includes('artifacts') ||
              references.has(file)
            )
              referencedPaths(readJson(file), references);
          }
      }
    }

    for (const [directory, files] of inventories) {
      try {
        if (
          fs.existsSync(path.join(directory, 'retired.json')) &&
          !protectedPath(directory)
        ) {
          // Forget ownership first. A crash during recursive removal must not
          // leave a pinned missing manifest that blocks all subsequent cleanup.
          store.locations?.forgetProject(
            path.basename(directory),
            path.dirname(directory),
          );
          // Keep the retirement marker until every possible manifest is gone.
          // Recursive rm(directory) can remove the marker before failing on a
          // child, making the surviving runs visible again after a restart.
          for (const entry of await fs.promises.readdir(directory))
            if (entry !== 'retired.json')
              await remove(path.join(directory, entry));
          await remove(path.join(directory, 'retired.json'));
          await fs.promises.rmdir(directory);
          continue;
        }
        const orphanBundles = new Set<string>();
        for (const file of files) {
          const parts = path.relative(directory, file).split(path.sep);
          const index = parts.indexOf('artifacts');
          if (index >= 0 && index + 1 < parts.length) {
            const bundle = path.join(directory, ...parts.slice(0, index + 2));
            if (
              !busy.some((dir) => within(dir, bundle)) &&
              !protectedPath(bundle)
            )
              orphanBundles.add(bundle);
          }
        }
        for (const bundle of orphanBundles) await remove(bundle);
        for (const file of files) {
          if (
            orphanBundles.size &&
            [...orphanBundles].some((dir) => within(dir, file))
          )
            continue;
          if (busy.some((dir) => within(dir, file)) || protectedPath(file))
            continue;
          const parts = path.relative(directory, file).split(path.sep);
          if (parts.includes('attempts') && media.test(file))
            await remove(file);
          else if (parts.some((part) => /\.pending-[a-zA-Z0-9-]+$/.test(part)))
            await remove(file);
        }
      } catch (error) {
        report.errors.push(String(error));
      }
    }
    for (const root of store.locations?.workspaceRoots() ?? []) {
      if (!fs.existsSync(root)) continue;
      for (const entry of await fs.promises.readdir(root, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name))
          continue;
        const directory = path.join(root, entry.name);
        if (liveWorkspaces.has(directory) || protectedPath(directory)) continue;
        const token = readJson<any>(path.join(directory, '.task-attempt.json'));
        if (!token?.projectId || !token.runId || !token.attemptId) continue;
        if (runs.some((run) => run.runId === token.runId && isRunLocked(run)))
          continue;
        await remove(directory);
      }
    }
  } catch (error) {
    report.errors.push(String(error));
  }
  return report;
}

/** Stage workspaces whose attempt token belongs to one of the given projects. */
async function ownedWorkspaces(store: TaskRunStore, projectIds: Set<string>) {
  const found: Array<{ directory: string; runId: string }> = [];
  for (const root of store.locations?.workspaceRoots() ?? []) {
    if (!fs.existsSync(root)) continue;
    for (const entry of await fs.promises.readdir(root, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      if (liveWorkspaces.has(directory)) continue;
      try {
        const token = readJson<any>(path.join(directory, '.task-attempt.json'));
        if (
          token?.projectId &&
          token.runId &&
          token.attemptId &&
          projectIds.has(token.projectId)
        )
          found.push({ directory, runId: token.runId });
      } catch {
        // An unreadable token means unknown ownership: retain it.
      }
    }
  }
  return found;
}

/**
 * Deleting a task reclaims its own retired data right away. Unlike
 * collectTaskRunGarbage this takes no maintenance lock and never inventories other
 * projects, so it also works while other tasks run. It only touches directories that
 * carry a `retired.json` marker (or stage workspaces owned by the deleted ids), and
 * anything uncertain is retained for the global collector.
 */
export async function reclaimRetiredProjects(
  store: TaskRunStore,
  options: {
    projectIds: string[];
    /** A function is only called when there is actually something to reclaim. */
    references: unknown[] | (() => unknown[] | Promise<unknown[]>);
  },
): Promise<ReclaimReport> {
  const report: ReclaimReport = {
    files: 0,
    bytes: 0,
    errors: [],
    retained: [],
  };
  const ids = new Set(options.projectIds);
  try {
    const directories = [...ids]
      .flatMap((id) => store.projectDirectories(id))
      .filter((directory) =>
        fs.existsSync(path.join(directory, 'retired.json')),
      );
    const workspaces = await ownedWorkspaces(store, ids);
    if (!directories.length && !workspaces.length) return report;
    const runs = store.all();
    const extra =
      typeof options.references === 'function'
        ? await options.references()
        : options.references;
    const references = await expandReferences([runs, ...extra]);
    const protectedPath = createProtector(references);
    for (const directory of directories) {
      const marker = path.join(directory, 'retired.json');
      try {
        // Unknown or corrupt metadata prevents deletion, exactly as in the global collector.
        for (const file of await walkFiles(directory))
          if (
            path.basename(file) === 'manifest.json' &&
            readJson<any>(file)?.schemaVersion !== TASK_RUN_SCHEMA_VERSION
          )
            throw new Error('TASK_RUN_VERSION_UNSUPPORTED');
        if (protectedPath(directory)) {
          report.retained.push(directory);
          continue;
        }
        // The same project id may have been created again while this was reading.
        if (!fs.existsSync(marker)) continue;
        // Forget ownership first so a crash mid-removal cannot leave a pinned missing manifest.
        store.locations?.forgetProject(
          path.basename(directory),
          path.dirname(directory),
        );
        for (const entry of await fs.promises.readdir(directory)) {
          if (entry === 'retired.json') continue;
          if (!fs.existsSync(marker)) break;
          await removeTree(path.join(directory, entry), report);
        }
        // Keep the marker until every possible manifest is gone, then drop it last.
        if (!fs.existsSync(marker)) continue;
        await removeTree(marker, report);
        await fs.promises.rmdir(directory);
      } catch (error) {
        report.errors.push(String(error));
      }
    }
    for (const { directory, runId } of workspaces) {
      try {
        if (liveWorkspaces.has(directory)) continue;
        if (protectedPath(directory)) {
          report.retained.push(directory);
          continue;
        }
        if (runs.some((run) => run.runId === runId && isRunLocked(run)))
          continue;
        await removeTree(directory, report);
      } catch (error) {
        report.errors.push(String(error));
      }
    }
  } catch (error) {
    report.errors.push(String(error));
  }
  return report;
}
