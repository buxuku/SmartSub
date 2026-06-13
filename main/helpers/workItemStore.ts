import { app } from 'electron';
import { store } from './store';
import type { TaskProject } from '../../types';
import type { ProofreadTask } from '../../types/proofread';
import type { WorkItem } from '../../types/workItem';
import { WORK_ITEM_MIGRATION_VERSION } from '../../types/workItem';
import { migrateLegacyStoresToWorkItems } from './workItemMigration';

const WORK_ITEMS_KEY = 'workItems';
const MIGRATION_VERSION_KEY = 'workItemsMigrationVersion';
const MAX_WORK_ITEMS = 100;

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

  if (!taskProjects.length && !proofreadTasks.length) {
    store.set(MIGRATION_VERSION_KEY, WORK_ITEM_MIGRATION_VERSION);
    return;
  }

  const result = migrateLegacyStoresToWorkItems({
    taskProjects,
    proofreadTasks,
  });

  workItems = result.items.slice(0, MAX_WORK_ITEMS);
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
    if (workItems.length > MAX_WORK_ITEMS) {
      workItems.splice(MAX_WORK_ITEMS);
    }
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

export function setupWorkItemStoreLifecycle(): void {
  app.on('before-quit', flushWrite);
}
