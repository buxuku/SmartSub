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
 * 「保存源字幕文件」的出厂默认是不保存（noSave）。「仅生成字幕」任务的源字幕就是最终交付物，
 * 停在 noSave 会让它以 `<视频名>_temp.srt` 落盘，播放器按同名加载不到；带翻译的任务里源字幕
 * 只是中间产物，不保存才是对的。所以每个提交「仅生成字幕」任务的入口都要把 noSave（或空值）
 * 读成 fileName：任务页改表单，向导在提交时改，面板只改显示（见 CommonSettings）。
 *
 * 返回该用的值；不需要修正（不是仅生成字幕，或者已经是有效选择）时返回 undefined。
 */
export function correctedSourceSrtSaveOption(
  taskType: string | undefined,
  option: unknown,
): 'fileName' | undefined {
  if (taskType !== 'generateOnly') return undefined;
  return !option || option === 'noSave' ? 'fileName' : undefined;
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
