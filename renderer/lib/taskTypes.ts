export type TaskTypeValue =
  | 'generateAndTranslate'
  | 'generateOnly'
  | 'translateOnly'
  | 'dubbing';

export interface TaskTypeDef {
  /** URL slug under /tasks/[type] */
  slug: string;
  /** value stored in userConfig.taskType */
  taskType: TaskTypeValue;
  /** what kind of files the task consumes */
  accepts: 'media' | 'subtitle';
  needsModel: boolean;
  /** 配音任务需已安装 TTS 模型 */
  needsTts?: boolean;
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
  {
    slug: 'dubbing',
    taskType: 'dubbing',
    accepts: 'subtitle',
    needsModel: false,
    needsTts: true,
    hasTranslate: false,
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

/** 拖放/导入时传给 getDroppedFiles 的 taskType 参数。 */
export function resolveDropTaskType(typeDef: TaskTypeDef): string {
  if (typeDef.taskType === 'dubbing') return 'dubbing';
  return typeDef.accepts === 'subtitle' ? 'translate' : 'media';
}

/** openDialog 的 fileType 参数。 */
export function resolveImportFileType(typeDef: TaskTypeDef): string {
  if (typeDef.taskType === 'dubbing') return 'dubbing';
  return typeDef.accepts === 'subtitle' ? 'srt' : 'media';
}
