import type { IFiles } from '../../types';
import {
  projectRunFiles,
  type TaskDraft,
  type TaskRun,
} from '../../types/taskRun';

/** Only input choices belong to an editable draft; stage evidence stays main-owned. */
export function taskDraftInput(file: IFiles, run?: TaskRun | null): IFiles {
  const previous = run?.files.find((entry) => entry.fileId === file.uuid);
  const input = Object.fromEntries(
    [
      'uuid',
      'filePath',
      'fileName',
      'fileExtension',
      'directory',
      'providedSubtitlePath',
      'manuscriptPath',
      'manuscriptName',
    ].map((key) => [key, file[key]]),
  ) as unknown as IFiles;
  for (const key of ['providedSubtitlePath', 'manuscriptPath'] as const) {
    if (previous && input[key] === previous.projection[key])
      input[key] = previous.input[key];
  }
  return input;
}

export function mergeDraftFiles(inputs: IFiles[], results: IFiles[]): IFiles[] {
  return inputs.map((input) => {
    const result = results.find(
      (file) => file.uuid === input.uuid && file.filePath === input.filePath,
    );
    return { ...result, ...taskDraftInput(input) };
  });
}

export function editableRunState(run: TaskRun, draft: TaskDraft | null) {
  const currentDraft = draft?.basedOnRunId === run.runId ? draft : null;
  const results = projectRunFiles(run);
  return {
    config: currentDraft?.config || run.config,
    files: currentDraft
      ? mergeDraftFiles(currentDraft.files, results)
      : results,
    draftRevision: draft?.revision || 0,
  };
}
