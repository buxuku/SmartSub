import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type {
  TaskSubmission,
  TaskSubmissionResult,
} from '../../types/taskSubmission';
import { taskSubmissionKey } from '../../types/taskSubmission';
import {
  isPipelineWorkItem,
  PIPELINE_WORK_ITEM_TYPES,
} from '../../types/workItem';
import { isPinnedTaskConfigSnapshot } from '../../types/taskSnapshot';
import { enforceSpeakerDiarizationTaskBoundary } from '../../types/speakerDiarization';
import {
  buildTaskName,
  derivePipelineWorkItemStatus,
} from './workItemMigration';
import { getWorkItemById, saveWorkItem } from './workItemStore';

/** Called synchronously with queue insertion: no other submission can interleave. */
export function persistTaskSubmission(
  input: TaskSubmission,
  busyFileUuids: ReadonlySet<string>,
): {
  result: Extract<TaskSubmissionResult, { success: true }>;
  submission: TaskSubmission;
} {
  if (
    !input?.projectId ||
    !input.requestId ||
    !Array.isArray(input.files) ||
    !input.files.length
  )
    throw new Error('TASK_SUBMISSION_INVALID');
  if (!PIPELINE_WORK_ITEM_TYPES.includes(input.formData?.taskType))
    throw new Error('TASK_TYPE_INVALID');
  const ids = input.files.map((file) => file?.uuid);
  if (
    ids.some((id) => typeof id !== 'string' || !id) ||
    new Set(ids).size !== ids.length ||
    input.files.some(
      (file) => typeof file.filePath !== 'string' || !file.filePath,
    )
  )
    throw new Error('TASK_FILES_INVALID');

  const existing = getWorkItemById(input.projectId);
  if (existing && !isPipelineWorkItem(existing))
    throw new Error('TASK_PROJECT_TYPE_CONFLICT');
  const fingerprint = createHash('sha256')
    .update(
      taskSubmissionKey({
        files: input.files,
        formData: input.formData,
      }),
    )
    .digest('hex');
  const previous = existing?.taskSubmissions?.find(
    (entry) => entry.requestId === input.requestId,
  );
  const result = {
    success: true as const,
    projectId: input.projectId,
    requestId: input.requestId,
    acceptedFileUuids: ids,
    duplicate: previous?.requestId === input.requestId,
  };
  if (result.duplicate) {
    if (previous.fingerprint !== fingerprint)
      throw new Error('TASK_REQUEST_CONFLICT');
    return { result, submission: input };
  }
  if (ids.some((id) => busyFileUuids.has(id)))
    throw new Error('TASK_FILES_BUSY');
  const formData = enforceSpeakerDiarizationTaskBoundary(
    structuredClone(
      isPinnedTaskConfigSnapshot(existing?.configSnapshot)
        ? existing.configSnapshot
        : input.formData,
    ),
  ) as TaskSubmission['formData'];
  if (
    busyFileUuids.size &&
    !isDeepStrictEqual(existing?.configSnapshot, formData)
  )
    throw new Error('TASK_CONFIG_BUSY');
  const submission = structuredClone({ ...input, formData });
  const incoming = new Map(submission.files.map((file) => [file.uuid, file]));
  const pipelineFiles = (existing?.pipelineFiles || [])
    .map((file) => {
      const next = incoming.get(file.uuid) || file;
      incoming.delete(file.uuid);
      return next;
    })
    .concat(Array.from(incoming.values()));
  const now = Date.now();
  saveWorkItem(
    {
      ...existing,
      id: input.projectId,
      name:
        existing?.name || input.name?.trim() || buildTaskName(pipelineFiles),
      type: formData.taskType,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status: derivePipelineWorkItemStatus(pipelineFiles),
      pipelineFiles,
      configSnapshot: formData,
      taskSubmissions: [
        ...(existing?.taskSubmissions || []),
        {
          requestId: input.requestId,
          fingerprint,
          acceptedAt: now,
        },
      ],
    },
    { durable: true },
  );
  return { result, submission };
}
