import type { IFiles, TaskProject } from '../../types';
import type { ProofreadTask } from '../../types/proofread';
import type { WorkItem, WorkItemStatus } from '../../types/workItem';
import {
  PIPELINE_WORK_ITEM_TYPES,
  type PipelineWorkItemType,
} from '../../types/workItem';

const STAGE_KEYS = [
  'extractAudio',
  'extractSubtitle',
  'translateSubtitle',
  'prepareSubtitle',
  'dubbing',
  'composeVideo',
] as const;

type StageKey = (typeof STAGE_KEYS)[number];

/** 默认任务名：时间 + 第一个文件名 */
export function buildTaskName(files: IFiles[], at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const first = files[0]?.fileName;
  return first ? `${time} · ${first}` : time;
}

function getStageError(file: IFiles, key: StageKey): string | undefined {
  const errorKey = `${key}Error` as keyof IFiles;
  const value = file[errorKey];
  return typeof value === 'string' ? value : undefined;
}

/** 从流水线文件列表推导 WorkItem 状态（不依赖 renderer stageUtils） */
export function derivePipelineWorkItemStatus(files: IFiles[]): WorkItemStatus {
  if (!files?.length) return 'waiting';

  let anyLoading = false;
  let anyError = false;
  let anyInterrupted = false;
  let anyReview = false;
  let hasAnyStage = false;
  let allStagesDone = true;

  for (const file of files) {
    // 人工检查点停靠：非完成、非错误的中间态
    if (file.subtitleGate === 'review' || file.dubbingGate === 'review') {
      anyReview = true;
    }
    for (const key of STAGE_KEYS) {
      const value = file[key as keyof IFiles];
      if (value === undefined || value === false) continue;

      hasAnyStage = true;
      if (value === 'loading') anyLoading = true;
      if (value === 'error') {
        anyError = true;
        if (getStageError(file, key) === 'TASK_INTERRUPTED') {
          anyInterrupted = true;
        }
      }
      if (value !== 'done') allStagesDone = false;
    }
  }

  if (anyLoading) return 'running';
  if (anyInterrupted) return 'interrupted';
  if (anyError) return 'error';
  if (anyReview) return 'review';
  if (hasAnyStage && allStagesDone) return 'done';
  return 'waiting';
}

export function taskProjectToWorkItem(project: TaskProject): WorkItem {
  const status = derivePipelineWorkItemStatus(project.files || []);

  return {
    id: project.id,
    name: project.name,
    type: project.taskType,
    status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    finishedAt: status === 'done' ? project.updatedAt : undefined,
    pipelineFiles: project.files || [],
  };
}

export function proofreadTaskToWorkItem(task: ProofreadTask): WorkItem {
  const status: WorkItemStatus =
    task.status === 'completed' ? 'done' : 'running';

  return {
    id: task.id,
    name: task.name,
    type: 'proofread',
    status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: status === 'done' ? task.updatedAt : undefined,
    proofreadEntries: task.items,
    currentProofreadIndex: task.currentItemIndex,
  };
}

export interface WorkItemMigrationInput {
  taskProjects?: TaskProject[];
  proofreadTasks?: ProofreadTask[];
}

export interface WorkItemMigrationResult {
  items: WorkItem[];
  fromTaskProjects: number;
  fromProofreadTasks: number;
}

/** 将 legacy 存储一次性转换为 WorkItem 列表（保留原 id） */
export function migrateLegacyStoresToWorkItems(
  input: WorkItemMigrationInput,
): WorkItemMigrationResult {
  const taskProjects = input.taskProjects || [];
  const proofreadTasks = input.proofreadTasks || [];

  const pipelineItems = taskProjects.map(taskProjectToWorkItem);
  const proofreadItems = proofreadTasks.map(proofreadTaskToWorkItem);

  const items = [...pipelineItems, ...proofreadItems].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  return {
    items,
    fromTaskProjects: pipelineItems.length,
    fromProofreadTasks: proofreadItems.length,
  };
}

export function workItemToTaskProject(item: WorkItem): TaskProject | null {
  if (
    item.type === 'proofread' ||
    !PIPELINE_WORK_ITEM_TYPES.includes(item.type as PipelineWorkItemType)
  ) {
    return null;
  }

  return {
    id: item.id,
    name: item.name,
    taskType: item.type as PipelineWorkItemType,
    files: item.pipelineFiles || [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function workItemToProofreadTask(item: WorkItem): ProofreadTask | null {
  if (item.type !== 'proofread') return null;

  return {
    id: item.id,
    name: item.name,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    items: item.proofreadEntries || [],
    currentItemIndex: item.currentProofreadIndex ?? 0,
    status: item.status === 'done' ? 'completed' : 'in_progress',
  };
}
