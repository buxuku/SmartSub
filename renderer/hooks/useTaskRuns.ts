import { useEffect, useState } from 'react';
import type { TaskRun } from '../../types/taskRun';

export function useTaskRuns(projectId?: string | null) {
  const [runs, setRuns] = useState<TaskRun[]>([]);
  useEffect(() => {
    setRuns([]);
    if (!projectId) return;
    let disposed = false;
    const merge = (incoming: TaskRun[]) =>
      setRuns((previous) => {
        const byId = new Map(previous.map((run) => [run.runId, run]));
        for (const run of incoming) {
          if (run.projectId !== projectId) continue;
          if ((byId.get(run.runId)?.revision ?? -1) < run.revision)
            byId.set(run.runId, run);
        }
        return Array.from(byId.values()).sort(
          (a, b) => b.createdAt - a.createdAt,
        );
      });
    void window.ipc
      .invoke('taskRuns:list', projectId)
      .then((value) => {
        if (!disposed) merge(value || []);
      })
      .catch(() => {});
    const cleanup = window.ipc.on('taskRunChange', (run: TaskRun) => {
      if (!disposed) merge([run]);
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [projectId]);
  const projectRuns = runs.filter((run) => run.projectId === projectId);
  return { runs: projectRuns, currentRun: projectRuns[0] || null };
}
