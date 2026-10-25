import { createHash, randomUUID } from 'node:crypto';
import type { IFiles } from '../../../types';
import {
  TASK_RUN_SCHEMA_VERSION,
  buildFileStagePlan,
  isRunLocked,
  type TaskRun,
  type TaskDraft,
  type AttemptToken,
  type StageRun,
  type StageId,
  type StageOutcome,
  type StageArtifact,
} from '../../../types/taskRun';
import type { TaskRunStore } from './store';
import { assertTaskResultsSaved, assertTaskRunResultEditable } from './access';

export function stableJson(value: any): string {
  if (Array.isArray(value))
    return `[${value.map((v) => stableJson(v) ?? 'null').join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const digestValue = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex');
export function assertValidRunInput(input: {
  projectId: string;
  requestId: string;
  files: IFiles[];
  config: Record<string, any>;
}) {
  if (
    !input.projectId ||
    !input.requestId ||
    !input.files?.length ||
    input.files.some(
      (file) =>
        !file?.uuid || typeof file.filePath !== 'string' || !file.filePath,
    ) ||
    !['generateOnly', 'generateAndTranslate', 'translateOnly'].includes(
      input.config?.taskType,
    ) ||
    new Set(input.files.map((file) => file.uuid)).size !== input.files.length
  )
    throw new Error('TASK_SUBMISSION_INVALID');
}
export function createTaskRunService(
  store: TaskRunStore,
  options: {
    onChange?: (run: TaskRun) => void;
    onProgress?: (run: TaskRun) => void;
  } = {},
) {
  const progressViews = new Map<string, TaskRun>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function get(projectId: string, runId?: string) {
    const pending = progressViews.get(projectId);
    if (pending && (!runId || pending.runId === runId))
      return structuredClone(pending);
    return runId
      ? store.read(projectId, runId)
      : store.list(projectId)[0] || null;
  }
  function save(run: TaskRun) {
    run.revision++;
    run.updatedAt = Date.now();
    store.write(run);
    progressViews.delete(run.projectId);
    clearTimeout(timers.get(run.projectId));
    timers.delete(run.projectId);
    options.onChange?.(structuredClone(run));
    return structuredClone(run);
  }
  function publishProgress(run: TaskRun) {
    run.revision++;
    run.updatedAt = Date.now();
    progressViews.set(run.projectId, run);
    options.onProgress?.(structuredClone(run));
    if (!timers.has(run.projectId)) {
      const timer = setTimeout(() => {
        timers.delete(run.projectId);
        const pending = progressViews.get(run.projectId);
        if (!pending) return;
        try {
          save(pending);
        } catch (error) {
          console.error('Task progress flush failed', error);
        }
      }, 500);
      timer.unref?.();
      timers.set(run.projectId, timer);
    }
  }
  const active = (run: TaskRun) =>
    run.files.some((file) =>
      Object.values(file.stages).some((stage) => stage.status === 'running'),
    );
  function aggregate(run: TaskRun) {
    const stages = run.files.flatMap((file) => Object.values(file.stages));
    if (run.status === 'cancelling') {
      if (!active(run)) run.status = 'cancelled';
      return;
    }
    if (run.status === 'pausing' || run.status === 'paused') {
      run.status = active(run) ? 'pausing' : 'paused';
      return;
    }
    if (active(run)) run.status = 'running';
    else if (
      run.files.some((file) =>
        Object.values(file.stages).some(
          (stage) =>
            stage.status === 'pending' &&
            stage.dependencies.every(
              (id) => file.stages[id]?.status === 'succeeded',
            ),
        ),
      )
    )
      run.status = 'queued';
    else if (stages.some((s) => s.status === 'waiting_review'))
      run.status = 'waiting_review';
    else if (stages.some((s) => s.status === 'failed')) run.status = 'failed';
    else if (stages.some((s) => s.status === 'interrupted'))
      run.status = 'interrupted';
    else if (stages.every((s) => s.status === 'succeeded'))
      run.status = 'succeeded';
    else run.status = 'queued';
  }
  function owned(
    token: AttemptToken,
  ): { run: TaskRun; stage: StageRun } | null {
    const run = get(token.projectId);
    if (!run || run.runId !== token.runId) return null;
    const stage = run.files.find((f) => f.fileId === token.fileId)?.stages[
      token.stageId
    ];
    return stage?.attemptId === token.attemptId && stage.status === 'running'
      ? { run, stage }
      : null;
  }
  return {
    get,
    list: store.list,
    importLegacyResult(input: {
      projectId: string;
      config: Record<string, any>;
      files: IFiles[];
      createdAt: number;
      status: TaskRun['status'];
    }) {
      if (store.list(input.projectId).length) return;
      const run: TaskRun = {
        schemaVersion: TASK_RUN_SCHEMA_VERSION,
        projectId: input.projectId,
        runId: `legacy-${randomUUID()}`,
        requestId: `legacy:${input.projectId}`,
        requestFingerprint: digestValue(input),
        legacy: { configurationComplete: false },
        config: structuredClone(input.config),
        resolvedConfig: {},
        status: input.status,
        revision: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        commands: {},
        files: input.files.map((file) => ({
          fileId: file.uuid,
          input: structuredClone(file),
          projection: structuredClone(file),
          stages: Object.fromEntries(
            buildFileStagePlan(file, input.config).map((id, index, ids) => [
              id,
              {
                id,
                version: 0,
                dependencies: index ? [ids[index - 1]] : [],
                status:
                  (file as any)[id] === 'done'
                    ? 'succeeded'
                    : (file as any)[id] === 'error'
                      ? 'failed'
                      : 'pending',
                sequence: 0,
                progress: (file as any)[id] === 'done' ? 100 : 0,
                artifacts: [],
              },
            ]),
          ),
        })),
      };
      // Legacy history is read-only and must never replace the live WorkItem projection.
      store.write(run);
      return structuredClone(run);
    },
    accept(input: {
      projectId: string;
      requestId: string;
      name?: string;
      config: Record<string, any>;
      resolvedConfig: Record<string, any>;
      files: IFiles[];
    }) {
      assertValidRunInput(input);
      // Replay identity is the request, not today's mutable global defaults.
      const fingerprint = digestValue({
        config: input.config,
        files: input.files,
      });
      const runs = store.list(input.projectId);
      const previous = runs.find((run) => run.requestId === input.requestId);
      if (previous) {
        if (previous.requestFingerprint !== fingerprint)
          throw new Error('TASK_REQUEST_CONFLICT');
        return { runId: previous.runId, duplicate: true };
      }
      if (runs.some(isRunLocked)) throw new Error('TASK_RUN_BUSY');
      const now = Math.max(Date.now(), (runs[0]?.createdAt || 0) + 1);
      const run: TaskRun = {
        schemaVersion: TASK_RUN_SCHEMA_VERSION,
        projectId: input.projectId,
        runId: randomUUID(),
        name: input.name?.trim() || undefined,
        previousRunId: runs[0]?.runId,
        requestId: input.requestId,
        requestFingerprint: fingerprint,
        config: structuredClone(input.config),
        resolvedConfig: structuredClone(input.resolvedConfig),
        status: 'queued',
        revision: 0,
        createdAt: now,
        updatedAt: now,
        commands: {},
        files: input.files.map((file) => {
          const plan = buildFileStagePlan(file, input.config);
          return {
            fileId: file.uuid,
            input: structuredClone(file),
            projection: structuredClone(file),
            stages: Object.fromEntries(
              plan.map((id, i) => [
                id,
                {
                  id,
                  // Version 2 retains rendered source SRT and provider filenames.
                  version: id === 'exportSubtitle' ? 2 : 1,
                  dependencies: i ? [plan[i - 1]] : [],
                  status: 'pending',
                  progress: 0,
                  sequence: 0,
                  artifacts: [],
                },
              ]),
            ),
          };
        }),
      };
      save(run);
      return { runId: run.runId, duplicate: false };
    },
    getDraft: store.readDraft,
    saveDraft(input: {
      projectId: string;
      expectedDraftRevision: number;
      config: Record<string, any>;
      files: IFiles[];
    }): TaskDraft {
      if (isRunLocked(get(input.projectId)))
        throw new Error('TASK_CONFIG_BUSY');
      const previous = store.readDraft(input.projectId);
      if ((previous?.revision || 0) !== input.expectedDraftRevision)
        throw new Error('TASK_DRAFT_CONFLICT');
      const draft = structuredClone({
        revision: input.expectedDraftRevision + 1,
        basedOnRunId: get(input.projectId)?.runId,
        config: input.config,
        files: input.files,
      });
      store.writeDraft(input.projectId, draft);
      return draft;
    },
    command(input: {
      projectId: string;
      expectedRunId: string;
      requestId: string;
      command: 'pause' | 'resume' | 'cancel' | 'retry';
    }) {
      const run = get(input.projectId);
      if (!run || run.runId !== input.expectedRunId)
        throw new Error('TASK_RUN_CONFLICT');
      if (run.legacy) throw new Error('TASK_HISTORY_READ_ONLY');
      if (input.command === 'resume' || input.command === 'retry')
        assertTaskResultsSaved(
          run.files.map((file) => file.projection.proofreadDataFile),
        );
      const fingerprint = digestValue(input);
      if (run.commands[input.requestId]) {
        if (run.commands[input.requestId].fingerprint !== fingerprint)
          throw new Error('TASK_REQUEST_CONFLICT');
        return run;
      }
      if (input.command === 'pause') {
        if (
          !['queued', 'running', 'preparing', 'pausing', 'paused'].includes(
            run.status,
          )
        )
          throw new Error('TASK_COMMAND_INVALID');
        run.status = active(run) ? 'pausing' : 'paused';
      } else if (input.command === 'resume') {
        if (run.status !== 'paused') throw new Error('TASK_COMMAND_INVALID');
        run.status = 'queued';
        aggregate(run);
      } else if (input.command === 'retry') {
        if (!['failed', 'interrupted'].includes(run.status))
          throw new Error('TASK_COMMAND_INVALID');
        for (const file of run.files)
          for (const stage of Object.values(file.stages))
            if (['failed', 'interrupted'].includes(stage.status)) {
              stage.status = 'pending';
              stage.attemptId = undefined;
              stage.error = undefined;
              stage.progress = 0;
              stage.sequence = 0;
            }
        run.status = 'queued';
      } else {
        if (!isRunLocked(run)) throw new Error('TASK_COMMAND_INVALID');
        run.status = active(run) ? 'cancelling' : 'cancelled';
      }
      run.commands[input.requestId] = { fingerprint };
      return save(run);
    },
    beginStage(
      projectId: string,
      runId: string,
      fileId: string,
      stageId: StageId,
    ): AttemptToken {
      const run = get(projectId);
      if (!run || run.runId !== runId) throw new Error('TASK_RUN_CONFLICT');
      if (run.legacy) throw new Error('TASK_HISTORY_READ_ONLY');
      if (['paused', 'pausing'].includes(run.status))
        throw new Error('TASK_RUN_PAUSED');
      if (
        !['queued', 'running', 'preparing', 'waiting_review'].includes(
          run.status,
        )
      )
        throw new Error('TASK_RUN_NOT_RUNNABLE');
      const file = run.files.find((f) => f.fileId === fileId);
      const stage = file?.stages[stageId];
      if (
        !stage ||
        stage.status !== 'pending' ||
        stage.dependencies.some((id) => file.stages[id]?.status !== 'succeeded')
      )
        throw new Error('TASK_STAGE_NOT_READY');
      stage.status = 'running';
      stage.attemptId = randomUUID();
      stage.sequence = 0;
      stage.progress = 0;
      run.status = 'running';
      save(run);
      return { projectId, runId, fileId, stageId, attemptId: stage.attemptId };
    },
    progress(input: AttemptToken & { sequence: number; progress: number }) {
      const found = owned(input);
      if (
        !found ||
        input.sequence <= found.stage.sequence ||
        found.run.status === 'cancelling'
      )
        return false;
      found.stage.sequence = input.sequence;
      found.stage.progress = Math.max(0, Math.min(100, input.progress));
      publishProgress(found.run);
      return true;
    },
    activity(token: AttemptToken, activity: IFiles['taskActivity']) {
      const found = owned(token);
      if (!found) return false;
      found.run.files.find(
        (file) => file.fileId === token.fileId,
      )!.projection.taskActivity = structuredClone(activity);
      publishProgress(found.run);
      return true;
    },
    finishStage(
      token: AttemptToken,
      result: {
        outcome: StageOutcome;
        artifacts: StageArtifact[];
        fingerprint?: string;
        reason?: string;
        reusedFrom?: string;
        projection?: IFiles;
        inputDigest?: string;
        inputIdentity?: TaskRun['files'][number]['inputIdentity'];
      },
    ) {
      const found = owned(token);
      if (!found) return false;
      if (found.run.status === 'cancelling') {
        found.stage.status = 'cancelled';
      } else {
        const { projection, inputDigest, inputIdentity, ...stageResult } =
          result;
        Object.assign(found.stage, structuredClone(stageResult), {
          status: 'succeeded',
          progress: 100,
        });
        const file = found.run.files.find(
          (file) => file.fileId === token.fileId,
        )!;
        if (projection)
          file.projection = structuredClone({
            ...projection,
            taskActivity: file.projection.taskActivity,
          });
        if (inputDigest) file.inputDigest = inputDigest;
        if (inputIdentity) file.inputIdentity = inputIdentity;
      }
      aggregate(found.run);
      save(found.run);
      return true;
    },
    failStage(token: AttemptToken, error: string) {
      const found = owned(token);
      if (!found) return false;
      found.stage.status =
        found.run.status === 'cancelling' ? 'cancelled' : 'failed';
      found.stage.error = error;
      aggregate(found.run);
      save(found.run);
      return true;
    },
    checkpoint(token: AttemptToken, projection: IFiles) {
      const found = owned(token);
      if (!found || found.run.status === 'cancelling') return false;
      found.run.files.find((file) => file.fileId === token.fileId)!.projection =
        structuredClone(projection);
      save(found.run);
      return true;
    },
    recordProofreadEdit(input: {
      projectId: string;
      runId: string;
      fileId: string;
      digest: string;
      translationFailures: IFiles['translationFailures'];
    }) {
      const run = get(input.projectId);
      if (!run || run.runId !== input.runId)
        throw new Error('TASK_RUN_CONFLICT');
      const file = run.files.find((file) => file.fileId === input.fileId);
      if (!file) throw new Error('TASK_FILE_NOT_FOUND');
      assertTaskRunResultEditable(run, file);
      file.projection.translationFailures = structuredClone(
        input.translationFailures,
      );
      (file.projection as any).manualProofreadRevision = input.digest;
      return save(run);
    },
    waitForReview(token: AttemptToken, projection: IFiles, revision: string) {
      const found = owned(token);
      if (!found) return false;
      found.stage.status =
        found.run.status === 'cancelling' ? 'cancelled' : 'waiting_review';
      found.stage.approvalRevision = revision;
      found.run.files.find((file) => file.fileId === token.fileId)!.projection =
        structuredClone(projection);
      aggregate(found.run);
      save(found.run);
      return true;
    },
    releaseReview(input: {
      projectId: string;
      runId: string;
      fileId: string;
      stageId: StageId;
      revision: string;
      projection: IFiles;
    }) {
      const run = get(input.projectId);
      if (
        !run ||
        run.runId !== input.runId ||
        !isRunLocked(run) ||
        ['cancelling', 'pausing', 'paused'].includes(run.status)
      )
        throw new Error('TASK_RUN_CONFLICT');
      const file = run.files.find((file) => file.fileId === input.fileId);
      const stage = file?.stages[input.stageId];
      if (!stage || stage.status !== 'waiting_review')
        throw new Error('TASK_REVIEW_NOT_READY');
      if (stage.approvalRevision !== input.revision)
        throw new Error('TASK_REVIEW_CONFLICT');
      stage.status = 'succeeded';
      stage.outcome = 'executed';
      stage.progress = 100;
      stage.fingerprint = digestValue({
        revision: input.revision,
        approval: input.projection,
      });
      file.projection = structuredClone(input.projection);
      aggregate(run);
      return save(run);
    },
    recover() {
      for (const run of store.all({ skipUnsupported: true })) {
        if (
          !['preparing', 'queued', 'running', 'pausing', 'cancelling'].includes(
            run.status,
          )
        )
          continue;
        const cancelling = run.status === 'cancelling';
        for (const file of run.files)
          for (const stage of Object.values(file.stages))
            if (stage.status === 'running') {
              stage.status = cancelling ? 'cancelled' : 'interrupted';
              stage.error = 'TASK_INTERRUPTED';
            }
        run.status = cancelling
          ? 'cancelled'
          : run.status === 'pausing'
            ? 'paused'
            : 'interrupted';
        save(run);
      }
    },
  };
}
export type TaskRunService = ReturnType<typeof createTaskRunService>;
