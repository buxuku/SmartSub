import {
  getFileStages,
  getStageStatus,
  hasFileError,
  isFileDone,
} from '@/components/tasks/stageUtils';
import {
  getTaskTypeBySlug,
  getTaskTypeByValue,
  type TaskTypeDef,
} from 'lib/taskTypes';
import type { WorkItem, WorkItemType } from '../../types/workItem';

export type RecentStatus = 'waiting' | 'running' | 'done' | 'error';

export const STATUS_DOT: Record<RecentStatus, string> = {
  waiting: 'bg-muted-foreground/40',
  running: 'bg-primary animate-pulse',
  done: 'bg-success',
  error: 'bg-destructive',
};

export const WORK_ITEM_TYPE_FILTERS: Array<'all' | WorkItemType> = [
  'all',
  'generateAndTranslate',
  'generateOnly',
  'translateOnly',
  'proofread',
  'dubbing',
];

function getProjectTypeDef(project: { taskType?: string }): TaskTypeDef {
  return (
    getTaskTypeByValue(project?.taskType) ||
    getTaskTypeBySlug('generate-translate')
  );
}

function getProjectStatus(project: {
  taskType?: string;
  files?: unknown[];
}): RecentStatus {
  const typeDef = getProjectTypeDef(project);
  const files: unknown[] = project?.files || [];
  if (!files.length) return 'waiting';
  let anyLoading = false;
  let anyError = false;
  let allDone = true;
  for (const file of files) {
    const stages = getFileStages(file, typeDef, undefined);
    if (stages.some((s) => getStageStatus(file, s.key) === 'loading')) {
      anyLoading = true;
    }
    if (hasFileError(file, stages)) anyError = true;
    if (!isFileDone(file, stages)) allDone = false;
  }
  if (anyLoading) return 'running';
  if (anyError) return 'error';
  if (allDone) return 'done';
  return 'waiting';
}

export function getWorkItemTarget(item: WorkItem, locale: string): string {
  if (item.type === 'proofread') {
    return `/${locale}/proofread?workItem=${item.id}`;
  }
  if (item.type === 'dubbing') {
    // 配音会话不持久化行状态：回开工作台并预填字幕/视频。
    const snapshot = (item.configSnapshot ?? {}) as {
      subtitlePath?: string;
      videoPath?: string;
    };
    const params = new URLSearchParams();
    if (snapshot.subtitlePath) params.set('subtitle', snapshot.subtitlePath);
    if (snapshot.videoPath) params.set('video', snapshot.videoPath);
    const query = params.toString();
    return `/${locale}/dubbing${query ? `?${query}` : ''}`;
  }
  const typeDef =
    getTaskTypeByValue(item.type) || getTaskTypeBySlug('generate-translate');
  return `/${locale}/tasks/${typeDef.slug}?project=${item.id}`;
}

export function getWorkItemFileCount(item: WorkItem): number {
  if (item.type === 'proofread') {
    return item.proofreadEntries?.length || 0;
  }
  if (item.type === 'dubbing') return 1;
  return item.pipelineFiles?.length || 0;
}

export function getWorkItemTypeLabel(
  item: WorkItem,
  tLaunchpad: (key: string) => string,
  tTasks: (key: string) => string,
): string {
  if (item.type === 'proofread') {
    return tLaunchpad('card.proofread');
  }
  if (item.type === 'dubbing') {
    return tLaunchpad('card.dubbing');
  }
  const typeDef =
    getTaskTypeByValue(item.type) || getTaskTypeBySlug('generate-translate');
  return tTasks(`pageTitle.${typeDef.slug}`);
}

export function getWorkItemStatus(item: WorkItem): RecentStatus {
  if (item.type === 'proofread' || item.type === 'dubbing') {
    if (item.status === 'done') return 'done';
    if (item.status === 'running') return 'running';
    if (item.status === 'error' || item.status === 'interrupted') {
      return 'error';
    }
    return 'waiting';
  }

  return getProjectStatus({
    taskType: item.type,
    files: item.pipelineFiles || [],
  });
}

export function formatWorkItemTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function filterWorkItems(
  items: WorkItem[],
  query: string,
  typeFilter: 'all' | WorkItemType,
): WorkItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  return items.filter((item) => {
    if (typeFilter !== 'all' && item.type !== typeFilter) return false;
    if (!normalizedQuery) return true;
    return (item.name || '').toLowerCase().includes(normalizedQuery);
  });
}
