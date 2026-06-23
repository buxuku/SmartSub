import { ipcMain } from 'electron';
import { IFiles, TaskProject, TaskProjectType } from '../../types';
import { isPipelineWorkItem } from '../../types/workItem';
import {
  deleteWorkItem,
  getWorkItemById,
  getWorkItems,
  renameWorkItem,
  saveWorkItem,
} from './workItemStore';
import {
  derivePipelineWorkItemStatus,
  taskProjectToWorkItem,
  workItemToTaskProject,
  buildTaskName,
} from './workItemMigration';

const TASK_TYPES: TaskProjectType[] = [
  'generateAndTranslate',
  'generateOnly',
  'translateOnly',
];

// Re-export for callers that imported buildTaskName from taskManager
export { buildTaskName } from './workItemMigration';

function normalizeTaskType(value: unknown): TaskProjectType {
  return TASK_TYPES.includes(value as TaskProjectType)
    ? (value as TaskProjectType)
    : 'generateAndTranslate';
}

function listTaskProjects(): TaskProject[] {
  return getWorkItems()
    .filter(isPipelineWorkItem)
    .map(workItemToTaskProject)
    .filter((project): project is TaskProject => project !== null);
}

function findWorkItemByFileUuid(uuid: string) {
  return getWorkItems().find(
    (item) =>
      isPipelineWorkItem(item) &&
      item.pipelineFiles?.some((file) => file.uuid === uuid),
  );
}

/**
 * 主进程侧镜像任务执行事件到 WorkItem 存储。
 */
export function applyTaskEventToProjects(
  channel: string,
  ...args: any[]
): void {
  const file = args[0] as IFiles | undefined;
  const uuid = file?.uuid;
  if (!uuid) return;

  const workItem = findWorkItemByFileUuid(uuid);
  if (!workItem || !isPipelineWorkItem(workItem)) return;

  const pipelineFiles = (workItem.pipelineFiles || []).map((item) => {
    if (item.uuid !== uuid) return item;
    const next: Record<string, any> = { ...item };
    switch (channel) {
      case 'taskStatusChange':
        next[args[1]] = args[2];
        break;
      case 'taskProgressChange':
        next[`${args[1]}Progress`] = args[2];
        break;
      case 'taskErrorChange':
        next[`${args[1]}Error`] = args[2];
        break;
      case 'taskFileChange':
        Object.assign(next, file);
        break;
      default:
        return item;
    }
    return next as IFiles;
  });

  saveWorkItem({
    ...workItem,
    pipelineFiles,
    status: derivePipelineWorkItemStatus(pipelineFiles),
    updatedAt: Date.now(),
  });
}

/** @deprecated 请使用 getWorkItems；保留兼容 shim */
export function setupTaskManager() {
  ipcMain.handle('getTaskProjects', () => listTaskProjects());

  ipcMain.handle('getTaskProject', (_event, id: string) => {
    const item = getWorkItemById(id);
    return item ? workItemToTaskProject(item) : null;
  });

  ipcMain.handle(
    'saveTaskProject',
    (
      _event,
      payload: {
        id: string;
        taskType?: TaskProjectType;
        files: IFiles[];
        name?: string;
      },
    ) => {
      const { id, taskType, files, name } = payload || {};
      if (!id) return null;

      if (!Array.isArray(files) || files.length === 0) {
        deleteWorkItem(id);
        return null;
      }

      const now = Date.now();
      const existing = getWorkItemById(id);
      const status = derivePipelineWorkItemStatus(files);

      if (existing && isPipelineWorkItem(existing)) {
        const saved = saveWorkItem({
          ...existing,
          pipelineFiles: files,
          status,
          updatedAt: now,
        });
        return workItemToTaskProject(saved);
      }

      const saved = saveWorkItem(
        taskProjectToWorkItem({
          id,
          name: name?.trim() || buildTaskName(files),
          taskType: normalizeTaskType(taskType),
          files,
          createdAt: now,
          updatedAt: now,
        }),
      );
      return workItemToTaskProject(saved);
    },
  );

  ipcMain.handle(
    'renameTaskProject',
    (_event, payload: { id: string; name: string }) => {
      const renamed = renameWorkItem(payload?.id, payload?.name || '');
      return renamed ? workItemToTaskProject(renamed) : null;
    },
  );

  ipcMain.handle('deleteTaskProject', (_event, id: string) => {
    deleteWorkItem(id);
    return true;
  });
}
