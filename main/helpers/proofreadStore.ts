/**
 * 校对任务存储管理
 * 支持批量任务管理（一个任务包含多个文件）
 */

import { v4 as uuidv4 } from 'uuid';
import { store } from './storeManager';
import {
  ProofreadTask,
  ProofreadItem,
  ProofreadHistory,
} from '../../types/proofread';
import path from 'path';

const TASKS_KEY = 'proofreadTasks';
const MAX_TASKS = 50;

// ============ 任务级别操作 ============

/**
 * 获取所有校对任务
 */
export function getProofreadTasks(): ProofreadTask[] {
  return (store.get(TASKS_KEY) as ProofreadTask[]) || [];
}

/**
 * 根据 ID 获取单个任务
 */
export function getProofreadTaskById(id: string): ProofreadTask | undefined {
  return getProofreadTasks().find((t) => t.id === id);
}

/**
 * 创建新任务
 * @param items 校对项目数据，可以包含可选的 status 字段
 * @param name 任务名称
 */
export function createProofreadTask(
  items: (Omit<
    ProofreadItem,
    'id' | 'lastPosition' | 'totalCount' | 'modifiedCount'
  > & { status?: ProofreadItem['status'] })[],
  name?: string,
): ProofreadTask {
  const tasks = getProofreadTasks();
  const now = Date.now();

  // 生成任务名称，默认取第一个文件名
  const taskName = name || generateTaskName(items[0]);

  // 创建校对项目，保留传入的 status（如果有）
  const proofreadItems: ProofreadItem[] = items.map((item, index) => ({
    ...item,
    id: uuidv4(),
    // 如果传入了 status，使用传入的值；否则第一个为 in_progress，其他为 pending
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

  // 添加到列表开头
  tasks.unshift(newTask);

  // 限制任务数量
  if (tasks.length > MAX_TASKS) {
    tasks.splice(MAX_TASKS);
  }

  store.set(TASKS_KEY, tasks);
  return newTask;
}

/**
 * 更新任务
 */
export function updateProofreadTask(
  taskId: string,
  updates: Partial<Omit<ProofreadTask, 'id' | 'createdAt'>>,
): ProofreadTask | null {
  const tasks = getProofreadTasks();
  const index = tasks.findIndex((t) => t.id === taskId);

  if (index < 0) return null;

  const existingTask = tasks[index];

  // 如果更新包含 items，需要保留或生成 ID
  if (updates.items) {
    updates.items = updates.items.map((item, i) => {
      // 如果 item 已有 ID，保留它
      if (item.id) {
        return item;
      }
      // 如果原任务的相同索引位置有 item，使用其 ID
      if (existingTask.items[i]?.id) {
        return { ...item, id: existingTask.items[i].id };
      }
      // 否则生成新 ID
      return { ...item, id: uuidv4() };
    });
  }

  const updated: ProofreadTask = {
    ...existingTask,
    ...updates,
    updatedAt: Date.now(),
  };

  tasks[index] = updated;
  store.set(TASKS_KEY, tasks);
  return updated;
}

/**
 * 删除任务
 */
export function deleteProofreadTask(taskId: string): boolean {
  const tasks = getProofreadTasks();
  const newTasks = tasks.filter((t) => t.id !== taskId);

  if (tasks.length !== newTasks.length) {
    store.set(TASKS_KEY, newTasks);
    return true;
  }

  return false;
}

/**
 * 清空所有任务
 */
export function clearProofreadTasks(): void {
  store.set(TASKS_KEY, []);
}

// ============ 项目级别操作 ============

/**
 * 更新任务中的单个项目
 */
export function updateProofreadItem(
  taskId: string,
  itemId: string,
  updates: Partial<Omit<ProofreadItem, 'id'>>,
): ProofreadItem | null {
  const tasks = getProofreadTasks();
  const taskIndex = tasks.findIndex((t) => t.id === taskId);

  if (taskIndex < 0) return null;

  const task = tasks[taskIndex];
  const itemIndex = task.items.findIndex((i) => i.id === itemId);

  if (itemIndex < 0) return null;

  const updatedItem: ProofreadItem = {
    ...task.items[itemIndex],
    ...updates,
  };

  task.items[itemIndex] = updatedItem;
  task.updatedAt = Date.now();

  // 检查是否所有项目都已完成
  const allCompleted = task.items.every((i) => i.status === 'completed');
  if (allCompleted) {
    task.status = 'completed';
  }

  tasks[taskIndex] = task;
  store.set(TASKS_KEY, tasks);
  return updatedItem;
}

/**
 * 标记项目为已完成，并移动到下一个
 */
export function completeProofreadItem(
  taskId: string,
  itemId: string,
): { task: ProofreadTask; nextItem: ProofreadItem | null } | null {
  const tasks = getProofreadTasks();
  const taskIndex = tasks.findIndex((t) => t.id === taskId);

  if (taskIndex < 0) return null;

  const task = tasks[taskIndex];
  const itemIndex = task.items.findIndex((i) => i.id === itemId);

  if (itemIndex < 0) return null;

  // 标记当前项目为已完成
  task.items[itemIndex].status = 'completed';

  // 查找下一个待处理的项目
  let nextItem: ProofreadItem | null = null;
  for (let i = itemIndex + 1; i < task.items.length; i++) {
    if (task.items[i].status !== 'completed') {
      task.items[i].status = 'in_progress';
      task.currentItemIndex = i;
      nextItem = task.items[i];
      break;
    }
  }

  // 检查是否所有项目都已完成
  const allCompleted = task.items.every((i) => i.status === 'completed');
  if (allCompleted) {
    task.status = 'completed';
  }

  task.updatedAt = Date.now();
  tasks[taskIndex] = task;
  store.set(TASKS_KEY, tasks);

  return { task, nextItem };
}

/**
 * 向任务添加新项目
 */
export function addItemsToTask(
  taskId: string,
  items: Omit<
    ProofreadItem,
    'id' | 'status' | 'lastPosition' | 'totalCount' | 'modifiedCount'
  >[],
): ProofreadTask | null {
  const tasks = getProofreadTasks();
  const taskIndex = tasks.findIndex((t) => t.id === taskId);

  if (taskIndex < 0) return null;

  const task = tasks[taskIndex];

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

  // 如果任务已完成但又添加了新项目，重新设为进行中
  if (task.status === 'completed') {
    task.status = 'in_progress';
    // 设置第一个新项目为进行中
    const firstNewItemIndex = task.items.length - newItems.length;
    task.items[firstNewItemIndex].status = 'in_progress';
    task.currentItemIndex = firstNewItemIndex;
  }

  tasks[taskIndex] = task;
  store.set(TASKS_KEY, tasks);
  return task;
}

/**
 * 从任务中移除项目
 */
export function removeItemFromTask(
  taskId: string,
  itemId: string,
): ProofreadTask | null {
  const tasks = getProofreadTasks();
  const taskIndex = tasks.findIndex((t) => t.id === taskId);

  if (taskIndex < 0) return null;

  const task = tasks[taskIndex];
  const itemIndex = task.items.findIndex((i) => i.id === itemId);

  if (itemIndex < 0) return null;

  task.items.splice(itemIndex, 1);
  task.updatedAt = Date.now();

  // 调整当前索引
  if (task.currentItemIndex >= task.items.length) {
    task.currentItemIndex = Math.max(0, task.items.length - 1);
  }

  // 如果没有项目了，删除整个任务
  if (task.items.length === 0) {
    tasks.splice(taskIndex, 1);
  } else {
    tasks[taskIndex] = task;
  }

  store.set(TASKS_KEY, tasks);
  return task.items.length > 0 ? task : null;
}

// ============ 辅助函数 ============

/**
 * 生成任务名称
 */
function generateTaskName(
  item: Omit<
    ProofreadItem,
    'id' | 'status' | 'lastPosition' | 'totalCount' | 'modifiedCount'
  >,
): string {
  // 优先使用视频文件名
  if (item.videoPath) {
    return path.basename(item.videoPath, path.extname(item.videoPath));
  }

  // 其次使用源字幕文件名
  if (item.sourceSubtitlePath) {
    const sourceName = path.basename(
      item.sourceSubtitlePath,
      path.extname(item.sourceSubtitlePath),
    );
    // 尝试去除语言后缀
    return sourceName.replace(/\.[a-z]{2}(?:-[A-Za-z]{2,4})?$/i, '');
  }

  return 'Untitled';
}

/**
 * 获取任务进度统计
 */
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

/**
 * 获取进行中的任务
 */
export function getInProgressTasks(): ProofreadTask[] {
  return getProofreadTasks().filter((t) => t.status === 'in_progress');
}

/**
 * 获取已完成的任务
 */
export function getCompletedTasks(): ProofreadTask[] {
  return getProofreadTasks().filter((t) => t.status === 'completed');
}

// ============ 兼容旧版本 ============

const HISTORY_KEY = 'proofreadHistories';

/**
 * 获取旧版历史记录（用于迁移）
 */
export function getProofreadHistories(): ProofreadHistory[] {
  return (store.get(HISTORY_KEY) as ProofreadHistory[]) || [];
}

/**
 * 清空旧版历史记录
 */
export function clearProofreadHistories(): void {
  store.set(HISTORY_KEY, []);
}
