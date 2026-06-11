import { app, ipcMain } from 'electron';
import { store } from './store';
import { IFiles, TaskProject, TaskProjectType } from '../../types';

let projects: TaskProject[] = [];
let writeTimer: NodeJS.Timeout | null = null;

const STAGE_KEYS = [
  'extractAudio',
  'extractSubtitle',
  'translateSubtitle',
  'prepareSubtitle',
] as const;

const TASK_TYPES: TaskProjectType[] = [
  'generateAndTranslate',
  'generateOnly',
  'translateOnly',
];

/** 上次运行中断的任务：loading 阶段改写为 error + 哨兵，renderer 翻译并提供重试 */
function markInterrupted(file: IFiles): IFiles {
  const next: Record<string, any> = { ...file };
  for (const key of STAGE_KEYS) {
    if (next[key] === 'loading') {
      next[key] = 'error';
      next[`${key}Error`] = 'TASK_INTERRUPTED';
    }
  }
  return next as IFiles;
}

/** 进度事件很频繁，落盘做防抖 */
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    store.set('taskProjects', projects);
  }, 800);
}

function flushWrite() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  store.set('taskProjects', projects);
}

/** 默认任务名：时间 + 第一个文件名 */
export function buildTaskName(files: IFiles[], at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const first = files[0]?.fileName;
  return first ? `${time} · ${first}` : time;
}

function normalizeTaskType(value: unknown): TaskProjectType {
  return TASK_TYPES.includes(value as TaskProjectType)
    ? (value as TaskProjectType)
    : 'generateAndTranslate';
}

/** 旧版扁平 tasks 列表迁移为单个任务工程 */
function migrateLegacyTasks() {
  const legacy = store.get('tasks');
  if (!Array.isArray(legacy)) return;
  if (legacy.length > 0 && projects.length === 0) {
    const now = Date.now();
    projects.push({
      id: `legacy-${now}`,
      name: buildTaskName(legacy),
      taskType: normalizeTaskType(store.get('userConfig')?.taskType),
      files: legacy,
      createdAt: now,
      updatedAt: now,
    });
  }
  store.delete('tasks');
}

function findProjectByFileUuid(uuid: string): TaskProject | undefined {
  return projects.find((p) => p.files.some((f) => f.uuid === uuid));
}

/**
 * 主进程侧镜像任务执行事件到任务工程存储。
 * 渲染层离开任务页后事件不再有人消费，没有这层镜像，
 * 工程内文件会永远停留在 loading 状态。
 */
export function applyTaskEventToProjects(
  channel: string,
  ...args: any[]
): void {
  const file = args[0] as IFiles | undefined;
  const uuid = file?.uuid;
  if (!uuid) return;
  const project = findProjectByFileUuid(uuid);
  if (!project) return;

  project.files = project.files.map((item) => {
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
  project.updatedAt = Date.now();
  scheduleWrite();
}

export function setupTaskManager() {
  const stored = store.get('taskProjects');
  projects = Array.isArray(stored) ? stored : [];
  migrateLegacyTasks();
  projects = projects.map((project) => ({
    ...project,
    files: (project.files || []).map(markInterrupted),
  }));
  flushWrite();

  ipcMain.handle('getTaskProjects', () => {
    return [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle('getTaskProject', (event, id: string) => {
    return projects.find((p) => p.id === id) || null;
  });

  /**
   * upsert 工程：files 为空时删除该工程（不保留空工程）。
   * 返回保存后的工程（或 null）。
   */
  ipcMain.handle(
    'saveTaskProject',
    (
      event,
      payload: { id: string; taskType?: TaskProjectType; files: IFiles[] },
    ) => {
      const { id, taskType, files } = payload || {};
      if (!id) return null;
      const index = projects.findIndex((p) => p.id === id);

      if (!Array.isArray(files) || files.length === 0) {
        if (index >= 0) {
          projects.splice(index, 1);
          flushWrite();
        }
        return null;
      }

      const now = Date.now();
      if (index >= 0) {
        projects[index] = {
          ...projects[index],
          files,
          updatedAt: now,
        };
        scheduleWrite();
        return projects[index];
      }

      const project: TaskProject = {
        id,
        name: buildTaskName(files),
        taskType: normalizeTaskType(taskType),
        files,
        createdAt: now,
        updatedAt: now,
      };
      projects.push(project);
      flushWrite();
      return project;
    },
  );

  ipcMain.handle(
    'renameTaskProject',
    (event, payload: { id: string; name: string }) => {
      const project = projects.find((p) => p.id === payload?.id);
      const name = payload?.name?.trim();
      if (!project || !name) return project || null;
      project.name = name;
      flushWrite();
      return project;
    },
  );

  ipcMain.handle('deleteTaskProject', (event, id: string) => {
    const index = projects.findIndex((p) => p.id === id);
    if (index >= 0) {
      projects.splice(index, 1);
      flushWrite();
    }
    return true;
  });

  app.on('before-quit', flushWrite);
}
