import { store } from './store';
import type { IFiles, TaskProject } from '../../types';
import type { ProofreadTask } from '../../types/proofread';
import type { WorkItem } from '../../types/workItem';
import { WORK_ITEM_MIGRATION_VERSION } from '../../types/workItem';
import {
  derivePipelineWorkItemStatus,
  migrateLegacyStoresToWorkItems,
  buildTaskName,
} from './workItemMigration';

const WORK_ITEMS_KEY = 'workItems';
const MIGRATION_VERSION_KEY = 'workItemsMigrationVersion';

const STAGE_KEYS = [
  'extractAudio',
  'extractSubtitle',
  'refineSubtitle',
  'manuscriptMatch',
  'translateSubtitle',
  'prepareSubtitle',
  'speakerDiarization',
  'exportSubtitle',
  'dubbing',
  'composeVideo',
] as const;

function markInterruptedFile(file: IFiles): IFiles {
  const next: Record<string, any> = { ...file };
  for (const key of STAGE_KEYS) {
    if (next[key] === 'loading') {
      next[key] = 'error';
      next[`${key}Error`] = 'TASK_INTERRUPTED';
    }
  }
  return next as IFiles;
}

function applyInterruptedMarkToWorkItems() {
  workItems = workItems.map((item) => {
    if (item.type === 'proofread') return item;
    if (item.type === 'download') {
      // 下载可断点续传：执行中的条目退回待下载（''），任务标记中断，
      // 「继续下载」时对未完成条目重新入列即可从断点恢复。
      if (item.status !== 'running' && item.status !== 'waiting') return item;
      const downloadEntries = (item.downloadEntries || []).map((entry) =>
        entry.status === 'loading' ? { ...entry, status: '' as const } : entry,
      );
      return item.status === 'running'
        ? { ...item, downloadEntries, status: 'interrupted' as const }
        : { ...item, downloadEntries };
    }
    if (item.type === 'dubbing') {
      // 配音是会话级工作项（无 pipelineFiles）：上次退出时仍在跑 → 标记中断。
      return item.status === 'running'
        ? { ...item, status: 'interrupted' as const }
        : item;
    }
    const pipelineFiles = (item.pipelineFiles || []).map(markInterruptedFile);
    return {
      ...item,
      pipelineFiles,
      status: derivePipelineWorkItemStatus(pipelineFiles),
    };
  });
}

let workItems: WorkItem[] = [];
let writeTimer: NodeJS.Timeout | null = null;
let initialized = false;
let hasPendingWrite = false;

function scheduleWrite(delay = 800) {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      flushWorkItemStore();
    } catch (error) {
      console.error('[workItemStore] Failed to persist task progress:', error);
      scheduleWrite(5000);
    }
  }, delay);
  writeTimer.unref?.();
}

function clearWriteTimer() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

export function flushWorkItemStore(): void {
  if (!initialized || !hasPendingWrite) return;
  store.set(WORK_ITEMS_KEY, workItems);
  hasPendingWrite = false;
  clearWriteTimer();
}

function commitWorkItems(next: WorkItem[]): void {
  // electron-store writes atomically and fsyncs before returning. Publish only
  // after that write succeeds, so a failed save cannot appear in subsequent reads.
  store.set(WORK_ITEMS_KEY, next);
  workItems = next;
  hasPendingWrite = false;
  clearWriteTimer();
}

function readMigrationVersion(): number {
  const version = store.get(MIGRATION_VERSION_KEY);
  return typeof version === 'number' ? version : 0;
}

function runMigrationIfNeeded() {
  const migrationVersion = readMigrationVersion();
  if (migrationVersion >= WORK_ITEM_MIGRATION_VERSION) {
    return;
  }

  if (workItems.length > 0) {
    store.set(MIGRATION_VERSION_KEY, WORK_ITEM_MIGRATION_VERSION);
    return;
  }

  const taskProjects = (store.get('taskProjects') as TaskProject[]) || [];
  const proofreadTasks = (store.get('proofreadTasks') as ProofreadTask[]) || [];
  const legacyTasks = store.get('tasks');

  let mergedTaskProjects = [...taskProjects];
  if (
    Array.isArray(legacyTasks) &&
    legacyTasks.length > 0 &&
    mergedTaskProjects.length === 0
  ) {
    const now = Date.now();
    mergedTaskProjects = [
      {
        id: `legacy-${now}`,
        name: buildTaskName(legacyTasks as IFiles[]),
        taskType:
          (store.get('userConfig')?.taskType as TaskProject['taskType']) ||
          'generateAndTranslate',
        files: legacyTasks as IFiles[],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  if (!mergedTaskProjects.length && !proofreadTasks.length) {
    store.set(MIGRATION_VERSION_KEY, WORK_ITEM_MIGRATION_VERSION);
    return;
  }

  const result = migrateLegacyStoresToWorkItems({
    taskProjects: mergedTaskProjects,
    proofreadTasks,
  });

  store.set({
    [WORK_ITEMS_KEY]: result.items,
    [MIGRATION_VERSION_KEY]: WORK_ITEM_MIGRATION_VERSION,
  });
  workItems = result.items;

  console.log(
    `[workItemStore] Migrated ${result.fromTaskProjects} taskProjects + ${result.fromProofreadTasks} proofreadTasks → ${workItems.length} workItems`,
  );
}

export function initializeWorkItemStore(): void {
  const stored = store.get(WORK_ITEMS_KEY);
  workItems = Array.isArray(stored) ? stored : [];
  runMigrationIfNeeded();
  applyInterruptedMarkToWorkItems();
  commitWorkItems(workItems);
  initialized = true;
}

export function getWorkItems(): WorkItem[] {
  return [...workItems].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getWorkItemById(id: string): WorkItem | null {
  return workItems.find((item) => item.id === id) || null;
}

export function saveWorkItem(
  item: WorkItem,
  options: { durable?: boolean } = {},
): WorkItem {
  const index = workItems.findIndex((existing) => existing.id === item.id);
  const now = Date.now();
  const next: WorkItem = {
    ...structuredClone(item),
    updatedAt: item.updatedAt || now,
    createdAt: item.createdAt || now,
  };

  const updated = [...workItems];
  if (index >= 0) updated[index] = next;
  else updated.unshift(next);

  if (options.durable) {
    commitWorkItems(updated);
  } else {
    workItems = updated;
    hasPendingWrite = true;
    scheduleWrite();
  }
  return structuredClone(next);
}

export function deleteWorkItem(id: string): boolean {
  const index = workItems.findIndex((item) => item.id === id);
  if (index < 0) return false;
  commitWorkItems(workItems.filter((item) => item.id !== id));
  return true;
}

export function renameWorkItem(id: string, name: string): WorkItem | null {
  const item = workItems.find((entry) => entry.id === id);
  const trimmed = name.trim();
  if (!item || !trimmed) return item || null;

  return saveWorkItem(
    { ...item, name: trimmed, updatedAt: Date.now() },
    { durable: true },
  );
}

export function clearAllWorkItems(): void {
  if (workItems.length === 0) return;
  commitWorkItems([]);
}
