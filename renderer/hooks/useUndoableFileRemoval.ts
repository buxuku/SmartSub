import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

export interface RemovableFile {
  uuid: string;
}

/**
 * Put a removed file back where it was. The position is clamped to the list as
 * it is now, and a file that is already in the list is not added twice.
 */
export function restoreRemovedFile<T extends RemovableFile>(
  list: T[],
  file: T,
  index: number,
): T[] {
  if (list.some((entry) => entry.uuid === file.uuid)) return list;
  const next = [...list];
  next.splice(Math.min(index, next.length), 0, file);
  return next;
}

interface UndoableFileRemovalOptions<T extends RemovableFile> {
  files: T[];
  setFiles: Dispatch<SetStateAction<T[]>>;
  /**
   * A task is running, paused or being cancelled: the main process may still be
   * working on the file, so the list must not lose it (same rule as "clear list").
   */
  locked: boolean;
  /** The project the list belongs to; an undo is dropped once it has changed. */
  projectIdRef: MutableRefObject<string | null>;
  /** Called after a removal; `undo` puts the file back. */
  onRemoved: (file: T, undo: () => void) => void;
}

/**
 * Removing one file from the task list takes effect at once and can be undone
 * (the page shows a toast for it, like "clear list"). Returns the remove
 * handler for the list components.
 */
export function useUndoableFileRemoval<T extends RemovableFile>({
  files,
  setFiles,
  locked,
  projectIdRef,
  onRemoved,
}: UndoableFileRemovalOptions<T>) {
  return useCallback(
    (uuid: string) => {
      if (locked) return;
      const index = files.findIndex((file) => file.uuid === uuid);
      if (index < 0) return;
      const removed = files[index];
      const owner = projectIdRef.current;
      setFiles((prev) => prev.filter((file) => file.uuid !== uuid));
      onRemoved(removed, () => {
        // Another project was opened within the undo window: leave it alone.
        if (projectIdRef.current !== owner) return;
        setFiles((prev) => restoreRemovedFile(prev, removed, index));
      });
    },
    [files, setFiles, locked, projectIdRef, onRemoved],
  );
}
