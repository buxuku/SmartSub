export type ITaskFile = {
  uuid: string;
  filePath: string;

  extractAudio?: StepKeyPossibleValues;
  extractSubtitle?: StepKeyPossibleValues;
  translateSubtitle?: StepKeyPossibleValues;

  taskType?: ITaskType;
  formData?: any; // 任务配置
};

type StepKeyPossibleValues = 'loading' | 'done' | 'error';

// 任务类型枚举
export type ITaskType =
  | 'generateAndTranslate'
  | 'generateOnly'
  | 'translateOnly';
