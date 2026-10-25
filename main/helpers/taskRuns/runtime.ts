import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createTaskRunStore } from './store';
import { assertValidRunInput, createTaskRunService } from './service';
import { captureEffectiveConfiguration } from './configuration';
import { configurationManager } from '../../service/configurationManager';
import { store } from '../store';
import { getWorkItemById, getWorkItems, saveWorkItem } from '../workItemStore';
import { buildTaskName } from '../workItemMigration';
import { withValidTranslateContent } from '../../../types/translateContent';
import { enforceSpeakerDiarizationTaskBoundary } from '../../../types/speakerDiarization';
import { projectRunFiles, type TaskRun } from '../../../types/taskRun';
import { subtitleOutputFilesToSave } from '../../../types/subtitleOutput';
import {
  setTaskRunServiceResolver,
  setManagedTaskAcceptance,
  setTaskRunEditGuard,
  setTaskRunDeletion,
  isLegacyTaskBusy,
  assertTaskResultsSaved,
  assertTaskRunResultEditable,
} from './access';
import type {
  TaskSubmission,
  TaskSubmissionResult,
} from '../../../types/taskSubmission';
import type { WorkItemStatus } from '../../../types/workItem';
import type { IFiles } from '../../../types';
import { captureModelIdentity } from './modelIdentity';
import { dubbingSessionOwnership } from '../dubbing/sessionOwnership';
import { readConfigDraft, readCueDraft } from '../dubbing/configDraftStore';

let singleton: ReturnType<typeof createTaskRunService> | undefined;
let manifests: ReturnType<typeof createTaskRunStore> | undefined;
export const runWorkItemStatus = (run: TaskRun): WorkItemStatus =>
  (
    ({
      succeeded: 'done',
      failed: 'error',
      cancelled: 'interrupted',
      interrupted: 'interrupted',
      waiting_review: 'review',
      queued: 'waiting',
      paused: 'waiting',
      pausing: 'running',
      cancelling: 'running',
      preparing: 'running',
      running: 'running',
    }) as const
  )[run.status];
export function projectRun(run: TaskRun, durable = true) {
  const old = getWorkItemById(run.projectId);
  saveWorkItem(
    {
      ...old,
      id: run.projectId,
      name:
        old?.name || run.name || buildTaskName(run.files.map((f) => f.input)),
      type: run.config.taskType,
      createdAt: old?.createdAt || run.createdAt,
      updatedAt: run.updatedAt,
      status: runWorkItemStatus(run),
      configSnapshot: run.config,
      currentRunId: run.runId,
      runStatus: run.status,
      runRevision: run.revision,
      historicalSessionIds: [
        ...new Set([
          ...(old?.historicalSessionIds || []),
          ...(old && old.currentRunId !== run.runId
            ? (old.pipelineFiles || []).flatMap((file) =>
                file.dubbingSessionId ? [file.dubbingSessionId] : [],
              )
            : []),
        ]),
      ],
      historicalProofreadFiles: [
        ...new Set([
          ...(old?.historicalProofreadFiles || []),
          ...(old && old.currentRunId !== run.runId
            ? (old.pipelineFiles || []).flatMap((file) =>
                file.proofreadDataFile ? [file.proofreadDataFile] : [],
              )
            : []),
        ]),
      ],
      pipelineFiles: projectRunFiles(run),
    },
    { durable },
  );
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('taskRunChange', run);
  }
}
export function getRunStore() {
  return (manifests ??= createTaskRunStore(
    path.join(app.getPath('userData'), 'task-runs'),
  ));
}
export function getRunService() {
  return (singleton ??= createTaskRunService(getRunStore(), {
    onChange: (run) => {
      try {
        projectRun(run);
      } catch (error) {
        console.error(
          'Task run projection failed; manifest remains authoritative',
          error,
        );
      }
    },
    onProgress: (run) => projectRun(run, false),
  }));
}
export function initializeTaskRuns() {
  getRunStore().reconcileRetirements(getWorkItems().map((item) => item.id));
  setTaskRunServiceResolver(getRunService);
  setManagedTaskAcceptance(acceptManagedTask);
  setTaskRunDeletion((ids) => getRunStore().prepareRetirement(ids));
  setTaskRunEditGuard((input) => {
    const all = getRunStore().all();
    if (
      input.path &&
      path.resolve(input.path).startsWith(getRunStore().root + path.sep) &&
      input.path.split(path.sep).includes('artifacts')
    )
      throw new Error('TASK_ARTIFACT_READ_ONLY');
    for (const run of all) {
      const file = input.sessionId
        ? run.files.find(
            (file) => file.projection.dubbingSessionId === input.sessionId,
          )
        : run.files.find(
            (file) =>
              input.path &&
              [
                file.projection.proofreadDataFile,
                file.projection.srtFile,
                file.projection.translatedSrtFile,
                file.projection.tempTranslatedSrtFile,
                ...subtitleOutputFilesToSave(file.projection).map(
                  (output) => output.filePath,
                ),
              ].some(
                (target) =>
                  target && path.resolve(target) === path.resolve(input.path!),
              ),
          );
      const owns =
        file ||
        (input.path &&
          path
            .resolve(input.path)
            .startsWith(
              path.dirname(getRunStore().runPath(run.projectId, run.runId)) +
                path.sep,
            ));
      if (!owns) continue;
      if (getRunService().get(run.projectId)?.runId !== run.runId)
        throw new Error('TASK_HISTORY_READ_ONLY');
      assertTaskRunResultEditable(run, file);
    }
  });
  getRunService().recover();
  const latest = new Map<string, TaskRun>();
  for (const run of getRunStore().all({ skipUnsupported: true }))
    if (
      !latest.has(run.projectId) ||
      latest.get(run.projectId)!.createdAt < run.createdAt
    )
      latest.set(run.projectId, run);
  for (const run of latest.values()) if (!run.legacy) projectRun(run);
}
/** An accepted input binding excludes all mutable legacy output/status fields. */
export function taskInput(file: IFiles): IFiles {
  return Object.fromEntries(
    [
      'uuid',
      'filePath',
      'fileName',
      'fileExtension',
      'directory',
      'providedSubtitlePath',
      'manuscriptPath',
      'manuscriptName',
    ]
      .filter((key) => (file as any)[key] !== undefined)
      .map((key) => [key, (file as any)[key]]),
  ) as unknown as IFiles;
}
export function acceptManagedTask(
  input: TaskSubmission,
):
  | { result: Extract<TaskSubmissionResult, { success: true }>; run: TaskRun }
  | undefined {
  const existing = getWorkItemById(input.projectId);
  assertTaskResultsSaved(
    (existing?.pipelineFiles || []).map((file) => file.proofreadDataFile),
  );
  if (!existing?.currentRunId && isLegacyTaskBusy(input.projectId))
    throw new Error('TASK_RUN_BUSY');
  if (input.resumeLegacy && existing && !existing.currentRunId)
    return undefined;
  const service = getRunService();
  const previousRun = service.get(input.projectId);
  for (const file of existing?.pipelineFiles || [])
    if (
      file.dubbingSessionId &&
      (dubbingSessionOwnership.isBusy(file.dubbingSessionId) ||
        readConfigDraft(file.dubbingSessionId) !== null ||
        readCueDraft(file.dubbingSessionId) !== null)
    )
      throw new Error('TASK_EDITOR_HAS_UNRESOLVED_CHANGES');
  const config = withValidTranslateContent(
    enforceSpeakerDiarizationTaskBoundary(structuredClone(input.formData)),
  );
  const resolvedConfig = captureEffectiveConfiguration(
    (key) => store.get(key as any),
    configurationManager.getTaskSnapshot(),
  );
  const identity = captureModelIdentity(
    config,
    resolvedConfig.settings,
    app.getPath('userData'),
  );
  const oldIdentity = service.get(input.projectId)?.resolvedConfig
    .modelIdentity;
  resolvedConfig.modelIdentity =
    !identity.files.length &&
    oldIdentity?.engine === identity.engine &&
    oldIdentity?.model === identity.model
      ? oldIdentity
      : identity;
  const submission = {
    projectId: input.projectId,
    requestId: input.requestId,
    name: input.name,
    config,
    resolvedConfig,
    files: input.files.map((file) => {
      const original = previousRun?.files.find(
        (old) => old.fileId === file.uuid,
      );
      const binding = { ...file };
      for (const key of ['providedSubtitlePath', 'manuscriptPath'] as const) {
        if (original && binding[key] === original.projection[key])
          binding[key] = original.input[key];
      }
      return taskInput(binding);
    }),
  };
  assertValidRunInput(submission);
  if (
    !existing?.currentRunId &&
    existing?.pipelineFiles?.some(
      (file) =>
        Object.values(file).some(
          (value) => value === 'done' || value === 'error',
        ) ||
        file.proofreadDataFile ||
        file.dubbingSessionId,
    )
  ) {
    service.importLegacyResult({
      projectId: input.projectId,
      config: existing.configSnapshot || { taskType: existing.type },
      files: existing.pipelineFiles,
      createdAt: existing.createdAt,
      status:
        existing.status === 'done'
          ? 'succeeded'
          : existing.status === 'error'
            ? 'failed'
            : 'interrupted',
    });
  }
  const receipt = service.accept(submission);
  const run = service.get(input.projectId, receipt.runId)!;
  return {
    result: {
      success: true,
      projectId: input.projectId,
      requestId: input.requestId,
      acceptedFileUuids: run.files.map((f) => f.fileId),
      ...receipt,
    },
    run,
  };
}
