import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { ipcMain } from '../../automation/handlers';
import { store } from '../store';
import { getWorkItems } from '../workItemStore';
import { getRunStore } from './runtime';
import { createTaskRunMigration } from './migration';
import { collectTaskRunGarbage, liveWorkspaces } from './cleanup';
import { readJson, referencedPaths, walkFiles } from './storageIO';
import { withTaskStorageMaintenance } from './maintenance';
import { hasTaskResultWrites } from './access';
import type {
  TaskStorageStatus,
  TaskStorageMigrationPreview,
} from '../../../types/taskStorage';

async function metadataFiles() {
  const files = new Set<string>([store.path]);
  for (const name of [
    'proofread-data',
    'proofread-drafts',
    'quality-reviews',
    'dubbing-sessions',
    'automation',
  ]) {
    const directory = path.join(app.getPath('userData'), name);
    if (fs.existsSync(directory))
      for (const file of await walkFiles(directory))
        if (file.endsWith('.json') || file.endsWith('.json.key'))
          files.add(file);
  }
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

let cleanup: Promise<any> | undefined;
export function cleanTaskStorage() {
  if (cleanup) return cleanup;
  cleanup = withTaskStorageMaintenance(async () => {
    const manifests = getRunStore();
    if (
      liveWorkspaces.size ||
      hasTaskResultWrites() ||
      manifests
        .all()
        .some((run) =>
          ['preparing', 'queued', 'running', 'pausing', 'cancelling'].includes(
            run.status,
          ),
        )
    )
      return { files: 0, bytes: 0, errors: ['TASK_STORAGE_BUSY'] };
    const references: unknown[] = [getWorkItems()];
    const migration = taskRunMigration().journal();
    if (migration?.phase === 'cleanup')
      references.push(
        migration.files
          ?.filter((file) => file.remove)
          .map((file) => ({ path: file.source })),
      );
    for (const file of await metadataFiles()) {
      if (file.endsWith('.json.key')) {
        if (readJson(file.slice(0, -4)) === null) continue;
        const key = await fs.promises.readFile(file, 'utf8');
        const prefix = 'smartsub_proofread_draft_v1:';
        if (!key.startsWith(prefix))
          throw new Error('TASK_DRAFT_IDENTITY_UNKNOWN');
        references.push(JSON.parse(key.slice(prefix.length)));
      } else references.push(readJson(file));
    }
    // Store config contains legacy task indexes; these also protect old references.
    return collectTaskRunGarbage(manifests, { references });
  })
    .catch((error) => ({ files: 0, bytes: 0, errors: [String(error)] }))
    .finally(() => {
      cleanup = undefined;
    });
  return cleanup;
}

export function setupTaskStorageHandlers() {
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
