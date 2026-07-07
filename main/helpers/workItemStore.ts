import { app } from 'electron';
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
  'translateSubtitle',
  'prepareSubtitle',
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

function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    store.set(WORK_ITEMS_KEY, workItems);
  }, 800);
}

function flushWrite() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  store.set(WORK_ITEMS_KEY, workItems);
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
    store.delete('tasks');
  }

  if (!mergedTaskProjects.length && !proofreadTasks.length) {
    store.set(MIGRATION_VERSION_KEY, WORK_ITEM_MIGRATION_VERSION);
    return;
  }

  const result = migrateLegacyStoresToWorkItems({
    taskProjects: mergedTaskProjects,
    proofreadTasks,
  });

  workItems = result.items;
  store.set(MIGRATION_VERSION_KEY, WORK_ITEM_MIGRATION_VERSION);
  flushWrite();

  console.log(
    `[workItemStore] Migrated ${result.fromTaskProjects} taskProjects + ${result.fromProofreadTasks} proofreadTasks → ${workItems.length} workItems`,
  );
}

export function initializeWorkItemStore(): void {
  const stored = store.get(WORK_ITEMS_KEY);
  workItems = Array.isArray(stored) ? stored : [];
  runMigrationIfNeeded();
  applyInterruptedMarkToWorkItems();
  flushWrite();
}

export function getWorkItems(): WorkItem[] {
  return [...workItems].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getWorkItemById(id: string): WorkItem | null {
  return workItems.find((item) => item.id === id) || null;
}

export function saveWorkItem(item: WorkItem): WorkItem {
  const index = workItems.findIndex((existing) => existing.id === item.id);
  const now = Date.now();
  const next: WorkItem = {
    ...item,
    updatedAt: item.updatedAt || now,
    createdAt: item.createdAt || now,
  };

  if (index >= 0) {
    workItems[index] = next;
  } else {
    workItems.unshift(next);
  }

  scheduleWrite();
  return next;
}

export function deleteWorkItem(id: string): boolean {
  const index = workItems.findIndex((item) => item.id === id);
  if (index < 0) return false;
  workItems.splice(index, 1);
  flushWrite();
  return true;
}

export function renameWorkItem(id: string, name: string): WorkItem | null {
  const item = workItems.find((entry) => entry.id === id);
  const trimmed = name.trim();
  if (!item || !trimmed) return item || null;

  item.name = trimmed;
  item.updatedAt = Date.now();
  flushWrite();
  return item;
}

export function clearAllWorkItems(): void {
  if (workItems.length === 0) return;
  workItems = [];
  flushWrite();
}

export function setupWorkItemStoreLifecycle(): void {
  app.on('before-quit', flushWrite);
}
