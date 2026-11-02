import fs from 'node:fs';
import path from 'node:path';
import type { TaskRunStore } from './store';
import { isRunLocked } from '../../../types/taskRun';
import { readJson, referencedPaths, walkFiles, within } from './storageIO';

export interface CleanupReport {
  files: number;
  bytes: number;
  errors: string[];
}
export const liveWorkspaces = new Set<string>();
const media = /\.(wav|mp3|m4a|flac|ogg|opus|aac|mp4|mkv|webm|mov)$/i;

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
    const protectedPath = (target: string) =>
      [...references].some(
        (ref) => path.relative(target, ref) === '' || within(target, ref),
      );
    async function remove(target: string) {
      const files = await walkFiles(target);
      const bytes = (
        await Promise.all(files.map((file) => fs.promises.stat(file)))
      ).reduce((sum, stat) => sum + stat.size, 0);
      await fs.promises.rm(target, { recursive: true, force: true });
      report.files += files.length;
      report.bytes += bytes;
    }
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
          await remove(directory);
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
