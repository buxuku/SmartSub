import { useCallback, useEffect, useRef, useState } from 'react';

export interface TaskProjectSave {
  id: string;
  taskType: string;
  files: any[];
  taskDraft?: { config: Record<string, any>; manuscripts: any[] };
  preserveTaskProgress: true;
}

export function taskProjectSaveKey(payload: TaskProjectSave): string {
  return JSON.stringify({
    ...payload,
    // Runtime progress is already persisted by the main process, not a user edit.
    files: payload.files.map((file) => ({
      uuid: file.uuid,
      filePath: file.filePath,
      providedSubtitlePath: file.providedSubtitlePath,
      manuscriptPath: file.manuscriptPath,
      manuscriptName: file.manuscriptName,
    })),
  });
}

/** Serialize saves and acknowledge only the exact revision that reached disk. */
export function useTaskProjectPersistence(
  payload: TaskProjectSave | null,
  onSaved: (saved: any) => void,
) {
  const latest = useRef<{ payload: TaskProjectSave; key: string } | null>(null);
  latest.current = payload
    ? { payload, key: taskProjectSaveKey(payload) }
    : null;
  const acknowledged = useRef(new Map<string, string>());
  const discardedVersions = useRef(new Map<string, number>());
  const inFlight = useRef<Promise<boolean> | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const [error, setError] = useState<string | null>(null);
  const [, refresh] = useState(0);
  const getIsDirty = useCallback(() => {
    const current = latest.current;
    return Boolean(
      current && acknowledged.current.get(current.payload.id) !== current.key,
    );
  }, []);
  const save = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const pending = (async () => {
      try {
        while (getIsDirty()) {
          const current = latest.current!;
          const version =
            discardedVersions.current.get(current.payload.id) ?? 0;
          let saved: any;
          try {
            saved = await window.ipc.invoke(
              'saveTaskProject',
              structuredClone(current.payload),
            );
          } catch (cause) {
            if (
              version !==
              (discardedVersions.current.get(current.payload.id) ?? 0)
            )
              continue;
            throw cause;
          }
          if (
            version !== (discardedVersions.current.get(current.payload.id) ?? 0)
          )
            continue;
          const deleting =
            !current.payload.files.length && !current.payload.taskDraft;
          if (
            deleting
              ? saved !== null
              : !saved || saved.id !== current.payload.id
          )
            throw new Error('TASK_PROJECT_SAVE_FAILED');
          acknowledged.current.set(current.payload.id, current.key);
          if (saved && latest.current?.payload.id === current.payload.id)
            onSavedRef.current(saved);
        }
        setError(null);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        refresh((value) => value + 1);
      }
    })();
    inFlight.current = pending;
    void pending.finally(() => {
      inFlight.current = null;
    });
    return pending;
  }, [getIsDirty]);
  const discard = useCallback(() => {
    const current = latest.current;
    if (current) {
      acknowledged.current.set(current.payload.id, current.key);
      discardedVersions.current.set(
        current.payload.id,
        (discardedVersions.current.get(current.payload.id) ?? 0) + 1,
      );
    }
    setError(null);
    refresh((value) => value + 1);
  }, []);
  const key = latest.current?.key;
  useEffect(() => {
    if (!getIsDirty()) return;
    const timer = setTimeout(() => {
      void save();
    }, 150);
    return () => clearTimeout(timer);
  }, [key, getIsDirty, save]);
  return { isDirty: getIsDirty(), getIsDirty, save, discard, error };
}
