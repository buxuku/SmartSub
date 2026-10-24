import type { IFiles } from '../../../types';
import type {
  AttemptToken,
  FileRun,
  StageRun,
  TaskRun,
} from '../../../types/taskRun';
import type { TaskRunService } from './service';

export interface StageExecutionContext {
  run: TaskRun;
  file: FileRun;
  stage: StageRun;
  token: AttemptToken;
  signal?: AbortSignal;
  progress: (percent: number) => void;
  checkpoint: (file: IFiles) => boolean;
  activity: (activity: IFiles['taskActivity']) => void;
}
export type StageResult = Parameters<TaskRunService['finishStage']>[1];
export type StageExecutor = (
  context: StageExecutionContext,
) => Promise<StageResult | { reviewRevision: string; projection: IFiles }>;
export type FileExecutionResult =
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled'
  | 'waiting_review';

/** Worker lifetime ends at a pause/review boundary, leaving no occupied scheduler slot. */
export async function executeFileRun(options: {
  service: TaskRunService;
  projectId: string;
  runId: string;
  fileId: string;
  signal?: AbortSignal;
  execute: StageExecutor;
}): Promise<FileExecutionResult> {
  const { service, projectId, runId, fileId, signal, execute } = options;
  for (;;) {
    const run = service.get(projectId);
    if (
      !run ||
      run.runId !== runId ||
      ['cancelled', 'cancelling'].includes(run.status)
    )
      return 'cancelled';
    if (['paused', 'pausing'].includes(run.status)) return 'paused';
    const file = run.files.find((file) => file.fileId === fileId)!;
    const stage = Object.values(file.stages).find(
      (stage) => stage.status !== 'succeeded',
    );
    if (!stage) return 'completed';
    if (stage.status === 'waiting_review') return 'waiting_review';
    if (stage.status !== 'pending') return 'failed';
    const token = service.beginStage(projectId, runId, fileId, stage.id);
    let sequence = 0;
    try {
      signal?.throwIfAborted();
      const result = await execute({
        run,
        file,
        stage,
        token,
        signal,
        progress: (progress) => {
          service.progress({ ...token, sequence: ++sequence, progress });
        },
        checkpoint: (projection) => service.checkpoint(token, projection),
        activity: (activity) => {
          service.activity(token, activity);
        },
      });
      if ('reviewRevision' in result) {
        service.waitForReview(token, result.projection, result.reviewRevision);
        return service.get(projectId)?.status === 'cancelled'
          ? 'cancelled'
          : 'waiting_review';
      }
      service.finishStage(token, result);
    } catch (error) {
      service.failStage(
        token,
        error instanceof Error ? error.message : String(error),
      );
      return signal?.aborted ? 'cancelled' : 'failed';
    }
  }
}
