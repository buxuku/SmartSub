import type { WorkItem } from '../../../types/workItem';

export function workItemSessionIds(item: WorkItem): string[] {
  return [
    ...new Set([
      ...(item.type === 'dubbing' &&
      typeof item.configSnapshot?.sessionId === 'string'
        ? [item.configSnapshot.sessionId]
        : []),
      ...(item.pipelineFiles || []).flatMap((file) =>
        file.dubbingSessionId ? [file.dubbingSessionId] : [],
      ),
    ]),
  ];
}
