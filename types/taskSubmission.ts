import type { IFiles } from './types';
import type { PipelineWorkItemType } from './workItem';

export interface TaskSubmission {
  requestId: string;
  projectId: string;
  files: IFiles[];
  formData: Record<string, any> & { taskType: PipelineWorkItemType };
  name?: string;
}

export type TaskSubmissionResult =
  | {
      success: true;
      projectId: string;
      requestId: string;
      acceptedFileUuids: string[];
      duplicate: boolean;
    }
  | { success: false; error: string };

export interface PendingTaskSubmission {
  key: string;
  requestId: string;
}

/** Stable across object reconstruction when a draft is restored. */
export function taskSubmissionKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
}
