import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createTaskRunStore } from './store';
import { createTaskRunService } from './service';
import { captureEffectiveConfiguration } from './configuration';
import { configurationManager } from '../../service/configurationManager';
import { store } from '../store';
import { getWorkItemById, saveWorkItem } from '../workItemStore';
import { buildTaskName } from '../workItemMigration';
import { withValidTranslateContent } from '../../../types/translateContent';
import { enforceSpeakerDiarizationTaskBoundary } from '../../../types/speakerDiarization';
import { type TaskRun } from '../../../types/taskRun';
import { setTaskRunServiceResolver } from './access';
import type { TaskSubmission, TaskSubmissionResult } from '../../../types/taskSubmission';
import type { WorkItemStatus } from '../../../types/workItem';
import type { IFiles } from '../../../types';

let singleton: ReturnType<typeof createTaskRunService> | undefined;
let manifests: ReturnType<typeof createTaskRunStore> | undefined;
export const runWorkItemStatus = (run: TaskRun): WorkItemStatus => ({ succeeded: 'done', failed: 'error', cancelled: 'interrupted', interrupted: 'interrupted', waiting_review: 'review', queued: 'waiting', paused: 'waiting', pausing: 'running', cancelling: 'running', preparing: 'running', running: 'running' } as const)[run.status];
export function projectRun(run: TaskRun) {
  const old = getWorkItemById(run.projectId);
  saveWorkItem({
    ...old, id: run.projectId, name: old?.name || buildTaskName(run.files.map(f => f.input)), type: run.config.taskType,
    createdAt: old?.createdAt || run.createdAt, updatedAt: run.updatedAt, status: runWorkItemStatus(run),
    configSnapshot: run.config, currentRunId: run.runId, runStatus: run.status, runRevision: run.revision,
    pipelineFiles: run.files.map(file => ({ ...file.projection, taskRunId: run.runId, taskRunRevision: run.revision, stageRuns: file.stages })),
  }, { durable: true });
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('taskRunChange', run);
  }
}
export function getRunStore() {
  return manifests ??= createTaskRunStore(path.join(app.getPath('userData'), 'task-runs'));
}
export function getRunService() {
  return singleton ??= createTaskRunService(getRunStore(), { onChange: run => {
    try { projectRun(run); } catch (error) { console.error('Task run projection failed; manifest remains authoritative', error); }
  } });
}
export function initializeTaskRuns() {
  setTaskRunServiceResolver(getRunService);
  getRunService().recover();
  const latest = new Map<string, TaskRun>();
  for (const run of getRunStore().all()) if (!latest.has(run.projectId) || latest.get(run.projectId)!.createdAt < run.createdAt) latest.set(run.projectId, run);
  for (const run of latest.values()) projectRun(run);
}
/** An accepted input binding excludes all mutable legacy output/status fields. */
export function taskInput(file: IFiles): IFiles {
  return Object.fromEntries(['uuid', 'filePath', 'fileName', 'fileExtension', 'directory', 'providedSubtitlePath', 'manuscriptPath', 'manuscriptName'].filter(key => (file as any)[key] !== undefined).map(key => [key, (file as any)[key]])) as unknown as IFiles;
}
export function acceptManagedTask(input: TaskSubmission): { result: Extract<TaskSubmissionResult, { success: true }>; run: TaskRun } {
  const service = getRunService();
  const config = withValidTranslateContent(enforceSpeakerDiarizationTaskBoundary(structuredClone(input.formData)));
  const resolvedConfig = captureEffectiveConfiguration(key => store.get(key as any), configurationManager.getTaskSnapshot());
  const receipt = service.accept({ projectId: input.projectId, requestId: input.requestId, config, resolvedConfig, files: input.files.map(taskInput) });
  const run = service.get(input.projectId, receipt.runId)!;
  return { result: { success: true, projectId: input.projectId, requestId: input.requestId, acceptedFileUuids: run.files.map(f => f.fileId), ...receipt }, run };
}
