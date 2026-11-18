import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { ipcMain } from '../../automation/handlers';
import { store } from '../store';
import { getWorkItems } from '../workItemStore';
import { getRunStore } from './runtime';
import { createTaskRunMigration } from './migration';
import {
  collectTaskRunGarbage,
  createProtector,
  expandReferences,
  liveWorkspaces,
  reclaimRetiredProjects,
  retiredDirectories,
} from './cleanup';
import { reclaimDeletedDrafts, type KeyedEntryStore } from './deletionReclaim';
import { readJson, referencedPaths, walkFiles } from './storageIO';
import { withTaskStorageMaintenance } from './maintenance';
import { hasTaskResultWrites } from './access';
import { logMessage } from '../logger';
import { createProofreadDraftStore } from '../proofreadDraftStore';
import { createQualityReviewStore } from '../qualityReviewStore';
import {
  setTaskDataReclaimer,
  type TaskDataReclaimRequest,
} from '../taskDataReclaim';
import type {
  TaskStorageStatus,
  TaskStorageMigrationPreview,
} from '../../../types/taskStorage';

const DRAFT_DIRECTORY = 'proofread-drafts';
const REVIEW_DIRECTORY = 'quality-reviews';

/**
 * Saved drafts and quality reviews are listed apart from the other records: deleting a
 * task removes its own before they get a chance to pin the storage it used.
 */
type ReferenceScope = 'all' | 'records' | 'drafts';

async function metadataFiles(scope: ReferenceScope = 'all') {
  const files = new Set<string>(scope === 'drafts' ? [] : [store.path]);
  for (const name of [
    'proofread-data',
    DRAFT_DIRECTORY,
    REVIEW_DIRECTORY,
    'dubbing-sessions',
    'automation',
  ]) {
    const isDraft = name === DRAFT_DIRECTORY || name === REVIEW_DIRECTORY;
    if (scope !== 'all' && isDraft !== (scope === 'drafts')) continue;
    const directory = path.join(app.getPath('userData'), name);
    if (fs.existsSync(directory))
      for (const file of await walkFiles(directory))
        if (file.endsWith('.json') || file.endsWith('.json.key'))
          files.add(file);
  }
  if (scope === 'drafts') return [...files];
  // Standalone proofread metadata can live alongside a user's media. Follow only
  // registered JSON references; never scan arbitrary output directories.
  const refs = referencedPaths([store.store, getWorkItems()]);
  for (const file of refs)
    if (file.endsWith('.json') && fs.existsSync(file)) {
      files.add(file);
      referencedPaths(readJson(file), refs);
    }
  return [...files];
}

export function taskRunMigration(
  progress?: (phase: string, current: number, total: number) => void,
) {
  return createTaskRunMigration(getRunStore(), {
    journalPath: path.join(app.getPath('userData'), 'task-run-migration.json'),
    metadataFiles,
    progress,
  });
}

export async function recoverTaskStorageMigration() {
  const migration = taskRunMigration();
  const state = migration.journal();
  if (!state || ['done', 'failed'].includes(state.phase)) return;
  // Native progress is available before any application editor opens.
  const progressWindow = new BrowserWindow({
    width: 460,
    height: 160,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const zh = store.get('settings')?.language === 'zh';
  await progressWindow.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<html><body style="font:16px system-ui;padding:24px"><p>${zh ? '正在迁移任务数据，请保持应用开启。' : 'Moving task data. Please keep the app open.'}</p></body></html>`,
      ),
  );
  const worker = taskRunMigration((phase, current, total) => {
    if (!progressWindow.isDestroyed()) {
      progressWindow.setProgressBar(total ? current / total : 0);
      progressWindow.setTitle(
        `${zh ? '迁移任务数据' : 'Moving task data'} — ${current}/${total}`,
      );
    }
  });
  try {
    await worker.execute();
  } finally {
    // Publication can succeed while removal of old copies needs a later retry.
    // Always reload the committed config before initializing in-memory indexes.
    if (['cleanup', 'done'].includes(worker.journal()?.phase || ''))
      store.store = readJson<any>(store.path);
    if (!progressWindow.isDestroyed()) progressWindow.destroy();
  }
}

/** Everything that can still point into task storage: records, drafts, sessions, receipts. */
async function collectStorageReferences(
  scope: ReferenceScope = 'all',
): Promise<unknown[]> {
  const references: unknown[] = [];
  if (scope !== 'drafts') {
    references.push(getWorkItems());
    const migration = taskRunMigration().journal();
    if (migration?.phase === 'cleanup')
      references.push(
        migration.files
          ?.filter((file) => file.remove)
          .map((file) => ({ path: file.source })),
      );
  }
  // Store config contains legacy task indexes; these also protect old references.
  for (const file of await metadataFiles(scope)) {
    if (file.endsWith('.json.key')) {
      if (readJson(file.slice(0, -4)) === null) continue;
      const key = await fs.promises.readFile(file, 'utf8');
      const prefix = 'smartsub_proofread_draft_v1:';
      if (!key.startsWith(prefix))
        throw new Error('TASK_DRAFT_IDENTITY_UNKNOWN');
      references.push(JSON.parse(key.slice(prefix.length)));
    } else references.push(readJson(file));
  }
  return references;
}

function draftStores(): KeyedEntryStore[] {
  const userData = app.getPath('userData');
  return [
    createProofreadDraftStore(path.join(userData, DRAFT_DIRECTORY)),
    createQualityReviewStore(path.join(userData, REVIEW_DIRECTORY)),
  ];
}

// The global collector and the per-deletion reclaim both remove retired data, so they
// run one at a time. The reclaim itself never takes the maintenance lock: it must work
// while other tasks are running.
let exclusive: Promise<unknown> = Promise.resolve();
function runExclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = exclusive.then(work);
  exclusive = result.catch(() => undefined);
  return result;
}

let cleanup: Promise<any> | undefined;
export function cleanTaskStorage() {
  if (cleanup) return cleanup;
  cleanup = runExclusive(() =>
    withTaskStorageMaintenance(async () => {
      const manifests = getRunStore();
      if (
        liveWorkspaces.size ||
        hasTaskResultWrites() ||
        manifests
          .all()
          .some((run) =>
            [
              'preparing',
              'queued',
              'running',
              'pausing',
              'cancelling',
            ].includes(run.status),
          )
      )
        return { files: 0, bytes: 0, errors: ['TASK_STORAGE_BUSY'] };
      const references = await collectStorageReferences();
      return collectTaskRunGarbage(manifests, { references });
    }),
  )
    .catch((error) => ({ files: 0, bytes: 0, errors: [String(error)] }))
    .finally(() => {
      cleanup = undefined;
    });
  return cleanup;
}

/**
 * Reclaims what freshly deleted work items left behind, while the user waits for the
 * deletion to finish. Nothing here may fail the deletion: problems are logged, and
 * leftovers fall back to the startup collector or the manual cache cleanup.
 */
export function reclaimDeletedWorkItems(
  request: TaskDataReclaimRequest,
): Promise<void> {
  return runExclusive(async () => {
    const ids = [...new Set(request.items.map((item) => item.id))];
    try {
      const runs = getRunStore();
      // The records are read at most once, whichever step needs them first.
      let records: Promise<unknown[]> | undefined;
      const recordReferences = () =>
        (records ??= collectStorageReferences('records'));
      // Saved drafts and quality reviews of these tasks go first: their identities name
      // files inside the task storage and would keep all of it pinned.
      const drafts = await reclaimDeletedDrafts(
        draftStores(),
        {
          sidecars: request.proofreadFiles,
          directories: retiredDirectories(runs, ids),
        },
        async () =>
          createProtector(
            await expandReferences([runs.all(), ...(await recordReferences())]),
          ),
      );
      if (drafts.removed)
        logMessage(
          `Task cleanup: removed ${drafts.removed} saved proofread draft(s) and review(s) of deleted tasks`,
          'info',
        );
      if (drafts.errors.length)
        logMessage(
          `Task cleanup could not remove some saved drafts: ${drafts.errors.join('; ')}`,
          'warning',
        );
      const retired = await reclaimRetiredProjects(runs, {
        projectIds: ids,
        references: async () => [
          ...(await recordReferences()),
          ...(await collectStorageReferences('drafts')),
        ],
      });
      if (retired.files)
        logMessage(
          `Task cleanup: reclaimed ${retired.files} files (${(retired.bytes / 1048576).toFixed(1)} MB) of deleted task data`,
          'info',
        );
      if (retired.retained.length)
        logMessage(
          `Task cleanup: kept ${retired.retained.length} location(s) still referenced by other records`,
          'info',
        );
      if (retired.errors.length)
        logMessage(
          `Task cleanup incomplete, the rest is collected later: ${retired.errors.join('; ')}`,
          'warning',
        );
    } catch (error) {
      logMessage(`Task cleanup failed: ${String(error)}`, 'warning');
    }
  });
}

export function setupTaskStorageHandlers() {
  setTaskDataReclaimer(reclaimDeletedWorkItems);
  const previews = new Map<string, TaskStorageMigrationPreview>();
  ipcMain.handle('taskStorage:status', async (): Promise<TaskStorageStatus> => {
    const manifests = getRunStore();
    const roots = [];
    for (const root of manifests.roots()) {
      let bytes = 0,
        available = true;
      try {
        if (fs.existsSync(root))
          for (const file of await walkFiles(root))
            bytes += (await fs.promises.stat(file)).size;
        else
          available = !manifests.locations
            ?.entries()
            .some(([, value]) => value === root);
      } catch {
        available = false;
      }
      roots.push({ path: root, bytes, available });
    }
    const migration = taskRunMigration().journal();
    return {
      root: manifests.root,
      roots,
      migration: migration
        ? { id: migration.id, phase: migration.phase, error: migration.error }
        : undefined,
    };
  });
  ipcMain.handle('taskStorage:previewMigration', async () => {
    const preview = await taskRunMigration().preview();
    previews.clear();
    previews.set(preview.id, preview);
    return preview;
  });
  ipcMain.handle(
    'taskStorage:scheduleMigration',
    async (_event, id: string) => {
      const old = previews.get(id);
      if (!old) throw new Error('TASK_MIGRATION_PREVIEW_EXPIRED');
      const preview = await taskRunMigration().preview();
      if (preview.blockers.length) throw new Error(preview.blockers.join('\n'));
      if (
        preview.target !== old.target ||
        JSON.stringify(preview.sources) !== JSON.stringify(old.sources) ||
        preview.files !== old.files ||
        preview.bytes !== old.bytes
      )
        throw new Error('TASK_MIGRATION_PREVIEW_EXPIRED');
      await taskRunMigration().schedule(id, preview.target);
      previews.clear();
      return true;
    },
  );
  ipcMain.handle('taskStorage:cancelMigration', async () => {
    await taskRunMigration().cancel();
    return true;
  });
  ipcMain.handle('taskStorage:cleanup', () => cleanTaskStorage());
}
