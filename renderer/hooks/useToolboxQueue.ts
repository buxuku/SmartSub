import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useNavigationGuard } from '../context/NavigationGuardContext';
import {
  ToolboxQueue,
  ToolboxQueueInput,
  ToolboxQueueResult,
} from '../lib/toolboxQueue';

export function useToolboxQueue<
  I extends ToolboxQueueInput,
  R extends ToolboxQueueResult,
>(progressChannel?: string) {
  const [queue] = useState(() => new ToolboxQueue<I, R>());
  const state = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  const id = useId();
  useNavigationGuard(`toolbox-queue-${id}`, {
    getIsDirty: () => {
      const current = queue.getSnapshot();
      return (
        current.running || current.items.some((item) => item.status !== 'done')
      );
    },
    isDirty:
      state.running || state.items.some((item) => item.status !== 'done'),
    onDiscard: () => {
      void queue.cancel();
    },
  });
  useEffect(() => {
    if (!progressChannel) return;
    return window.ipc?.on(
      progressChannel,
      (data: { jobId: string; percent: number }) =>
        queue.progress(data.jobId, data.percent),
    );
  }, [queue, progressChannel]);
  useEffect(
    () => () => {
      void queue.cancel();
    },
    [queue],
  );
  return { ...state, queue };
}

export function droppedToolboxPaths(event: React.DragEvent): string[] {
  event.preventDefault();
  event.stopPropagation();
  return Array.from(event.dataTransfer.files)
    .map((file) => window.ipc.getPathForFile(file))
    .filter(Boolean);
}
