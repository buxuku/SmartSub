export type TaskTypeValue =
  | 'generateAndTranslate'
  | 'generateOnly'
  | 'translateOnly';

export interface TaskTypeDef {
  /** URL slug under /tasks/[type] */
  slug: string;
  /** value stored in userConfig.taskType */
  taskType: TaskTypeValue;
  /** what kind of files the task consumes */
  accepts: 'media' | 'subtitle';
  needsModel: boolean;
  hasTranslate: boolean;
}

export const TASK_TYPES: TaskTypeDef[] = [
  {
    slug: 'generate-translate',
    taskType: 'generateAndTranslate',
    accepts: 'media',
    needsModel: true,
    hasTranslate: true,
  },
  {
    slug: 'generate',
    taskType: 'generateOnly',
    accepts: 'media',
    needsModel: true,
    hasTranslate: false,
  },
  {
    slug: 'translate',
    taskType: 'translateOnly',
    accepts: 'subtitle',
    needsModel: false,
    hasTranslate: true,
  },
];

export function getTaskTypeBySlug(slug: string): TaskTypeDef | undefined {
  return TASK_TYPES.find((t) => t.slug === slug);
}

export function getTaskTypeByValue(
  taskType: string | undefined,
): TaskTypeDef | undefined {
  return TASK_TYPES.find((t) => t.taskType === taskType);
}

/**
 * 向导流水线任务（配置快照含配音/成片附加阶段）的页面标题键
 * （tasks.json `pageTitle.*`）；无附加阶段返回 null（沿用 slug 标题）。
 */
export function getPipelineTitleKey(
  snapshot: { dub?: unknown; compose?: unknown } | null | undefined,
  accepts: 'media' | 'subtitle',
): string | null {
  const dub = Boolean(snapshot?.dub);
  const compose = Boolean(snapshot?.compose);
  if (dub && compose) return 'pipelineDubCompose';
  if (compose) return 'pipelineCompose';
  if (dub) {
    return accepts === 'subtitle' ? 'pipelineDubSubtitle' : 'pipelineDub';
  }
  return null;
}
