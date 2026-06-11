import { IFiles } from '../../types';

export type TaskStepKey =
  | 'extractAudio'
  | 'extractSubtitle'
  | 'translateSubtitle';

type TaskType = 'generateAndTranslate' | 'generateOnly' | 'translateOnly';

interface TaskFormData {
  taskType?: TaskType;
  translateProvider?: string;
}

const TASK_STATE_KEYS = [
  'extractAudio',
  'extractSubtitle',
  'translateSubtitle',
  'prepareSubtitle',
  'processFile',
] as const;

function isSubtitlePath(filePath?: string): boolean {
  return /\.(srt|vtt|ass|ssa|lrc)$/i.test(filePath || '');
}

function getTaskType(formData: TaskFormData): TaskType {
  return formData?.taskType || 'generateAndTranslate';
}

function shouldTranslate(formData: TaskFormData): boolean {
  const taskType = getTaskType(formData);
  return (
    (taskType === 'generateAndTranslate' || taskType === 'translateOnly') &&
    formData?.translateProvider !== '-1'
  );
}

export function getRequiredTaskSteps(
  file: IFiles,
  formData: TaskFormData,
): TaskStepKey[] {
  const taskType = getTaskType(formData);
  const steps: TaskStepKey[] = [];

  if (taskType !== 'translateOnly' && !isSubtitlePath(file.filePath)) {
    steps.push('extractAudio', 'extractSubtitle');
  }

  if (shouldTranslate(formData)) {
    steps.push('translateSubtitle');
  }

  return steps;
}

export function isTaskComplete(file: IFiles, formData: TaskFormData): boolean {
  const steps = getRequiredTaskSteps(file, formData);
  return steps.length > 0 && steps.every((step) => file[step] === 'done');
}

export function hasTaskFailure(file: IFiles, formData: TaskFormData): boolean {
  return getRequiredTaskSteps(file, formData).some(
    (step) => file[step] === 'error',
  );
}

export function getRunnableTaskFiles(
  files: IFiles[],
  formData: TaskFormData,
): IFiles[] {
  return files.filter((file) => {
    const steps = getRequiredTaskSteps(file, formData);
    return steps.length > 0 && !isTaskComplete(file, formData);
  });
}

export function getFailedTaskFiles(
  files: IFiles[],
  formData: TaskFormData,
): IFiles[] {
  return files.filter((file) => hasTaskFailure(file, formData));
}

export function resetTaskRunState(file: IFiles): IFiles {
  const nextFile = { ...file };

  TASK_STATE_KEYS.forEach((key) => {
    delete nextFile[key];
    delete nextFile[`${key}Progress`];
    delete nextFile[`${key}Error`];
  });

  return nextFile;
}
