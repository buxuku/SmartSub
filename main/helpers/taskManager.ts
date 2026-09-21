import { ipcMain } from 'electron';
import { IFiles, TaskProject, TaskProjectType } from '../../types';
import { isPipelineWorkItem, type WorkItem } from '../../types/workItem';
import { getTaskContext } from './taskContext';
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
  const projectId = getTaskContext()?.projectId;
  return getWorkItems().find(
    (item) =>
      (!projectId || item.id === projectId) &&
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

  // A new session must be reachable after a crash before synthesis may begin.
  const linkChanged = pipelineFiles.some(
    (next, index) =>
      next.dubbingSessionId !==
      workItem.pipelineFiles?.[index]?.dubbingSessionId,
  );
  saveWorkItem(
    {
      ...workItem,
      pipelineFiles,
      status: derivePipelineWorkItemStatus(pipelineFiles),
      updatedAt: Date.now(),
    },
    { durable: linkChanged },
  );
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
        taskDraft?: WorkItem['taskDraft'];
        preserveTaskProgress?: boolean;
      },
    ) => {
      const { id, taskType, files, name, taskDraft } = payload || {};
      if (!id) return null;

      if (!Array.isArray(files)) throw new Error('TASK_FILES_INVALID');
      if (
        taskDraft &&
        (!taskDraft.config || !Array.isArray(taskDraft.manuscripts))
      )
        throw new Error('TASK_DRAFT_INVALID');
      if (files.length === 0 && !taskDraft) {
        deleteWorkItem(id);
        return null;
      }

      const now = Date.now();
      const existing = getWorkItemById(id);
      if (existing && !isPipelineWorkItem(existing))
        throw new Error('TASK_PROJECT_TYPE_CONFLICT');
      const currentFiles = new Map(
        existing?.pipelineFiles?.map((file) => [file.uuid, file]),
      );
      const pipelineFiles = payload.preserveTaskProgress
        ? files.map((file) => ({
            ...file,
            ...currentFiles.get(file.uuid),
            manuscriptPath: file.manuscriptPath,
            manuscriptName: file.manuscriptName,
          }))
        : files;
      const status = derivePipelineWorkItemStatus(pipelineFiles);

      if (existing && isPipelineWorkItem(existing)) {
        const saved = saveWorkItem(
          {
            ...existing,
            type: taskType ? normalizeTaskType(taskType) : existing.type,
            pipelineFiles,
            ...(taskDraft ? { taskDraft: structuredClone(taskDraft) } : {}),
            status,
            updatedAt: now,
          },
          { durable: true },
        );
        return workItemToTaskProject(saved);
      }

      const saved = saveWorkItem(
        {
          ...taskProjectToWorkItem({
            id,
            name: name?.trim() || buildTaskName(files),
            taskType: normalizeTaskType(taskType),
            files: pipelineFiles,
            createdAt: now,
            updatedAt: now,
          }),
          ...(taskDraft ? { taskDraft: structuredClone(taskDraft) } : {}),
        },
        { durable: true },
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
