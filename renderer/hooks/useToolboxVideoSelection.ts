import { useEffect, useState } from 'react';
import type {
  ToolboxQueue,
  ToolboxQueueItem,
  ToolboxQueueResult,
} from '../lib/toolboxQueue';

export interface ToolboxVideoInput {
  filePath: string;
  startSec?: number;
  endSec?: number;
}

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  size: number;
}

async function loadVideoInfo(filePath: string): Promise<VideoInfo> {
  const info: VideoInfo = await window.ipc.invoke(
    'toolbox:getVideoInfo',
    filePath,
  );
  if (!Number.isFinite(info?.duration) || info.duration <= 0)
    throw new Error('Invalid video duration');
  return info;
}

export async function resolveToolboxVideoRange(
  input: ToolboxVideoInput,
  defaultEnd?: number,
) {
  const info = await loadVideoInfo(input.filePath);
  const startSec = input.startSec ?? 0;
  const endSec =
    input.endSec ?? Math.min(defaultEnd ?? info.duration, info.duration);
  if (
    !Number.isFinite(startSec) ||
    !Number.isFinite(endSec) ||
    startSec < 0 ||
    endSec <= startSec ||
    endSec > info.duration + 0.001
  ) {
    throw new Error('The selected range must fall within the video duration.');
  }
  return { info, startSec, endSec };
}

export function useToolboxVideoSelection<R extends ToolboxQueueResult>(
  queue: ToolboxQueue<ToolboxVideoInput, R>,
  items: ToolboxQueueItem<ToolboxVideoInput, R>[],
  defaultEnd?: number,
) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = items.find((item) => item.id === selectedId) || items[0];
  const [loaded, setLoaded] = useState<{ id: string; info: VideoInfo }>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    setLoadError(undefined);
    setLoaded(undefined);
    if (selected) {
      loadVideoInfo(selected.filePath)
        .then((info) => {
          if (!disposed) setLoaded({ id: selected.id, info });
        })
        .catch((error) => {
          if (!disposed) setLoadError(String(error));
        });
    }
    return () => {
      disposed = true;
    };
  }, [selected?.id, defaultEnd]);
  const info = loaded?.id === selected?.id ? loaded?.info : undefined;
  const startSec = selected?.input.startSec ?? 0;
  const endSec =
    selected?.input.endSec ??
    Math.min(defaultEnd ?? info?.duration ?? 0, info?.duration ?? 0);
  const setRange = (field: 'startSec' | 'endSec', value: number) => {
    if (!selected || queue.getSnapshot().running) return;
    queue.updateInput(selected.id, {
      ...selected.input,
      startSec,
      endSec,
      [field]: value,
    });
  };
  return {
    selectedId: selected?.id,
    select: setSelectedId,
    videoPath: selected?.filePath,
    info,
    loadError,
    startSec,
    endSec,
    setStartSec: (value: number) => setRange('startSec', value),
    setEndSec: (value: number) => setRange('endSec', value),
  };
}
