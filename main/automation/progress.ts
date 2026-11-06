import { automationEvents } from './events';

const mediaChannels: Record<string, string> = {
  'media.trim': 'toolbox:trimProgress',
  'media.extract-audio': 'toolbox:audioProgress',
  'media.compress': 'toolbox:compressProgress',
  'media.gif': 'toolbox:gifProgress',
};

/** Subscribe for one running job. Never forward another job's paths or progress. */
export function subscribeJobProgress(
  jobId: string,
  operation: string,
  update: (channel: string, ...args: any[]) => void,
) {
  let modelKey: string | undefined;
  let composeId: string | undefined;
  const listener = (channel: string, ...args: any[]) => {
    const data = args[0];
    if (channel === mediaChannels[operation] && data?.jobId === jobId)
      update(channel, data);
    if (
      operation === 'models.install' &&
      modelKey &&
      data === modelKey &&
      ['downloadProgress', 'modelDownloadDetail'].includes(channel)
    )
      update(channel, ...args);
    if (operation !== 'compose.run') return;
    if (channel === 'subtitleMerge:queued' && data?.requestId === jobId)
      composeId = data.jobId;
    if (channel === 'compose:queue' && Array.isArray(data)) {
      const entry = data.find((item) => item.requestId === jobId);
      if (entry) {
        composeId = entry.id;
        update(channel, entry);
      }
    }
    if (
      channel === 'subtitleMerge:progress' &&
      composeId &&
      data?.jobId === composeId
    )
      update(channel, data);
  };
  automationEvents.on('event', listener);
  return {
    // Called only after model-download exclusion checks, immediately before the
    // handler synchronously acquires its shared lock.
    trackModel: (key: string) => {
      modelKey = key;
    },
    dispose: () => {
      automationEvents.off('event', listener);
    },
  };
}
