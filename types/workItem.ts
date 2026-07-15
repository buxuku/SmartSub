import type { IFiles } from './types';
import type { ProofreadItem } from './proofread';

/** 流水线类工作项（转写 / 翻译） */
export type PipelineWorkItemType =
  | 'generateAndTranslate'
  | 'generateOnly'
  | 'translateOnly';

/** 校对批次工作项 */
export type ProofreadWorkItemType = 'proofread';

/** 配音工作台工作项（会话级：字幕 + 可选视频 → 配音产物） */
export type DubbingWorkItemType = 'dubbing';

export type WorkItemType =
  | PipelineWorkItemType
  | ProofreadWorkItemType
  | DubbingWorkItemType;

export type WorkItemStatus =
  | 'waiting'
  | 'running'
  | 'done'
  | 'error'
  | 'interrupted'
  /** 有文件停靠在人工检查点等待校对（非完成、非错误的中间态） */
  | 'review';

/** 流水线文件 — P19-1 先与 IFiles 对齐，后续正型 */
export type PipelineFile = IFiles;

/** 校对项 — 与 ProofreadItem 对齐 */
export type ProofreadEntry = ProofreadItem;

export interface WorkItemArtifact {
  kind: string;
  path: string;
}

export interface WorkItem {
  id: string;
  name: string;
  type: WorkItemType;
  status: WorkItemStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;

  /** generate* / translate* */
  pipelineFiles?: PipelineFile[];

  /** proofread */
  proofreadEntries?: ProofreadEntry[];
  currentProofreadIndex?: number;

  configSnapshot?: Record<string, unknown>;
  artifacts?: WorkItemArtifact[];
}

export const WORK_ITEM_MIGRATION_VERSION = 1;

export const PIPELINE_WORK_ITEM_TYPES: PipelineWorkItemType[] = [
  'generateAndTranslate',
  'generateOnly',
  'translateOnly',
];

export function isPipelineWorkItem(
  item: WorkItem,
): item is WorkItem & { pipelineFiles: PipelineFile[] } {
  return PIPELINE_WORK_ITEM_TYPES.includes(item.type as PipelineWorkItemType);
}

export function isProofreadWorkItem(
  item: WorkItem,
): item is WorkItem & { proofreadEntries: ProofreadEntry[] } {
  return item.type === 'proofread';
}
