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
