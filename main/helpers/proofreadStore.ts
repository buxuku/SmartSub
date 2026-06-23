/**
 * 校对任务存储管理 —  backed by unified WorkItem store (P19)
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { store } from './storeManager';
import {
  ProofreadTask,
  ProofreadItem,
  ProofreadHistory,
} from '../../types/proofread';
import { deleteWorkItem, getWorkItems, saveWorkItem } from './workItemStore';
import {
  proofreadTaskToWorkItem,
  workItemToProofreadTask,
} from './workItemMigration';

const HISTORY_KEY = 'proofreadHistories';

function persistProofreadTask(task: ProofreadTask): void {
  saveWorkItem(proofreadTaskToWorkItem(task));
}

// ============ 任务级别操作 ============

export function getProofreadTasks(): ProofreadTask[] {
  return getWorkItems()
    .filter((item) => item.type === 'proofread')
    .map(workItemToProofreadTask)
    .filter((task): task is ProofreadTask => task !== null);
}

export function getProofreadTaskById(id: string): ProofreadTask | undefined {
  return getProofreadTasks().find((t) => t.id === id);
}

export function createProofreadTask(
  items: (Omit<
    ProofreadItem,
    'id' | 'lastPosition' | 'totalCount' | 'modifiedCount'
  > & { status?: ProofreadItem['status'] })[],
  name?: string,
): ProofreadTask {
  const now = Date.now();
  const taskName = name || generateTaskName(items[0]);

  const proofreadItems: ProofreadItem[] = items.map((item, index) => ({
    ...item,
    id: uuidv4(),
    status: item.status || (index === 0 ? 'in_progress' : 'pending'),
    lastPosition: 0,
    totalCount: 0,
    modifiedCount: 0,
  }));

  const newTask: ProofreadTask = {
    id: uuidv4(),
    name: taskName,
    createdAt: now,
    updatedAt: now,
    items: proofreadItems,
    currentItemIndex: 0,
    status: 'in_progress',
  };

  persistProofreadTask(newTask);
  return newTask;
}

export function updateProofreadTask(
  taskId: string,
  updates: Partial<Omit<ProofreadTask, 'id' | 'createdAt'>>,
): ProofreadTask | null {
  const existingTask = getProofreadTaskById(taskId);
  if (!existingTask) return null;

  if (updates.items) {
    updates.items = updates.items.map((item, i) => {
      if (item.id) return item;
      if (existingTask.items[i]?.id) {
        return { ...item, id: existingTask.items[i].id };
      }
      return { ...item, id: uuidv4() };
    });
  }

  const updated: ProofreadTask = {
    ...existingTask,
    ...updates,
    updatedAt: Date.now(),
  };

  persistProofreadTask(updated);
  return updated;
}

export function deleteProofreadTask(taskId: string): boolean {
  return deleteWorkItem(taskId);
}

export function clearProofreadTasks(): void {
  for (const task of getProofreadTasks()) {
    deleteWorkItem(task.id);
  }
}

// ============ 项目级别操作 ============

export function updateProofreadItem(
  taskId: string,
  itemId: string,
  updates: Partial<Omit<ProofreadItem, 'id'>>,
): ProofreadItem | null {
  const task = getProofreadTaskById(taskId);
  if (!task) return null;

  const itemIndex = task.items.findIndex((i) => i.id === itemId);
  if (itemIndex < 0) return null;

  const updatedItem: ProofreadItem = {
    ...task.items[itemIndex],
    ...updates,
  };

  task.items[itemIndex] = updatedItem;
  task.updatedAt = Date.now();

  const allCompleted = task.items.every((i) => i.status === 'completed');
  if (allCompleted) {
    task.status = 'completed';
  }

  persistProofreadTask(task);
  return updatedItem;
}

export function completeProofreadItem(
  taskId: string,
  itemId: string,
): { task: ProofreadTask; nextItem: ProofreadItem | null } | null {
  const task = getProofreadTaskById(taskId);
  if (!task) return null;

  const itemIndex = task.items.findIndex((i) => i.id === itemId);
  if (itemIndex < 0) return null;

  task.items[itemIndex].status = 'completed';

  let nextItem: ProofreadItem | null = null;
  for (let i = itemIndex + 1; i < task.items.length; i++) {
    if (task.items[i].status !== 'completed') {
      task.items[i].status = 'in_progress';
      task.currentItemIndex = i;
      nextItem = task.items[i];
      break;
    }
  }

  const allCompleted = task.items.every((i) => i.status === 'completed');
  if (allCompleted) {
    task.status = 'completed';
  }

  task.updatedAt = Date.now();
  persistProofreadTask(task);

  return { task, nextItem };
}

export function addItemsToTask(
  taskId: string,
  items: Omit<
    ProofreadItem,
    'id' | 'status' | 'lastPosition' | 'totalCount' | 'modifiedCount'
  >[],
): ProofreadTask | null {
  const task = getProofreadTaskById(taskId);
  if (!task) return null;

  const newItems: ProofreadItem[] = items.map((item) => ({
    ...item,
    id: uuidv4(),
    status: 'pending' as const,
    lastPosition: 0,
    totalCount: 0,
    modifiedCount: 0,
  }));

  task.items.push(...newItems);
  task.updatedAt = Date.now();

  if (task.status === 'completed') {
    task.status = 'in_progress';
    const firstNewItemIndex = task.items.length - newItems.length;
    task.items[firstNewItemIndex].status = 'in_progress';
    task.currentItemIndex = firstNewItemIndex;
  }

  persistProofreadTask(task);
  return task;
}

export function removeItemFromTask(
  taskId: string,
  itemId: string,
): ProofreadTask | null {
  const task = getProofreadTaskById(taskId);
  if (!task) return null;

  const itemIndex = task.items.findIndex((i) => i.id === itemId);
  if (itemIndex < 0) return null;

  task.items.splice(itemIndex, 1);
  task.updatedAt = Date.now();

  if (task.currentItemIndex >= task.items.length) {
    task.currentItemIndex = Math.max(0, task.items.length - 1);
  }

  if (task.items.length === 0) {
    deleteWorkItem(taskId);
    return null;
  }

  persistProofreadTask(task);
  return task;
}

// ============ 辅助函数 ============

function generateTaskName(
  item: Omit<
    ProofreadItem,
    'id' | 'status' | 'lastPosition' | 'totalCount' | 'modifiedCount'
  >,
): string {
  if (item.videoPath) {
    return path.basename(item.videoPath, path.extname(item.videoPath));
  }

  if (item.sourceSubtitlePath) {
    const sourceName = path.basename(
      item.sourceSubtitlePath,
      path.extname(item.sourceSubtitlePath),
    );
    return sourceName.replace(/\.[a-z]{2}(?:-[A-Za-z]{2,4})?$/i, '');
  }

  return 'Untitled';
}

export function getTaskProgress(task: ProofreadTask): {
  completed: number;
  total: number;
  percent: number;
} {
  const completed = task.items.filter((i) => i.status === 'completed').length;
  const total = task.items.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { completed, total, percent };
}

export function getInProgressTasks(): ProofreadTask[] {
  return getProofreadTasks().filter((t) => t.status === 'in_progress');
}

export function getCompletedTasks(): ProofreadTask[] {
  return getProofreadTasks().filter((t) => t.status === 'completed');
}

// ============ 兼容旧版本 ============

export function getProofreadHistories(): ProofreadHistory[] {
  return (store.get(HISTORY_KEY) as ProofreadHistory[]) || [];
}

export function clearProofreadHistories(): void {
  store.set(HISTORY_KEY, []);
}
