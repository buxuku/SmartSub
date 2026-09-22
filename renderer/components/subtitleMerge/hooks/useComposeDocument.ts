import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearComposeDraft,
  cloneCompose,
  readComposeDraft,
  writeComposeDraft,
  type ComposeDocument,
  type ComposeDraft,
  type ComposeJobReference,
} from '../../../lib/composeDraft';
import { acquireComposeDraftLock } from '../../../lib/composeDraftLock';

type Change =
  | Partial<ComposeDocument>
  | ((current: ComposeDocument) => Partial<ComposeDocument>);
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// The owning panel is keyed by its incoming media paths, just like the draft.
export function useComposeDocument(key: string, initial: ComposeDocument) {
  const current = useRef(cloneCompose(initial));
  const saved = useRef(cloneCompose(initial));
  const touched = useRef(false);
  const pending = useRef<ComposeDraft | null>(null);
  const job = useRef<ComposeJobReference | null>();
  const readFailed = useRef(false);
  const initialized = useRef(false);
  const ownsLock = useRef(false);
  const hasSaved = useRef(false);
  const persistenceFailed = useRef(false);
  const history = useRef<ComposeDocument[]>([]);
  const future = useRef<ComposeDocument[]>([]);
  const group = useRef<{ name?: string; time: number }>({ time: 0 });
  const epoch = useRef(0);
  const [revision, render] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockState, setLockState] = useState<'waiting' | 'owned' | 'error'>(
    'waiting',
  );
  const [lockAttempt, setLockAttempt] = useState(0);
  const getIsDirty = useCallback(
    () =>
      persistenceFailed.current ||
      (touched.current && !equal(current.current, saved.current)),
    [],
  );
  const isBlocked = useCallback(
    () =>
      !ownsLock.current ||
      !initialized.current ||
      !!pending.current ||
      readFailed.current,
    [],
  );
  const endGroup = useCallback(() => {
    group.current = { time: 0 };
  }, []);
  const persist = useCallback(
    (clean = false) => {
      try {
        writeComposeDraft(
          key,
          {
            version: 1,
            job: job.current,
            current: current.current,
            saved: clean ? current.current : saved.current,
            dirty:
              !clean &&
              touched.current &&
              !equal(current.current, saved.current),
          },
          clean,
        );
        persistenceFailed.current = false;
        setError(null);
        return true;
      } catch (cause) {
        persistenceFailed.current = true;
        setError(String(cause));
        return false;
      }
    },
    [key, getIsDirty],
  );
  const read = useCallback(() => {
    if (!ownsLock.current) return;
    try {
      const draft = readComposeDraft(key);
      job.current = draft?.job;
      readFailed.current = false;
      setError(null);
      pending.current = null;
      if (draft && !draft.dirty) {
        current.current = cloneCompose(draft.current);
        saved.current = cloneCompose(draft.current);
        touched.current = true;
        hasSaved.current = true;
      } else pending.current = draft;
    } catch (cause) {
      readFailed.current = true;
      setError(String(cause));
    }
    initialized.current = true;
    setReady(true);
    render((value) => value + 1);
  }, [key]);
  useEffect(() => {
    setLockState('waiting');
    const release = acquireComposeDraftLock(
      key,
      () => {
        ownsLock.current = true;
        setLockState('owned');
        read();
      },
      (cause) => {
        setLockState('error');
        setError(String(cause));
      },
    );
    return () => {
      ownsLock.current = false;
      release();
    };
  }, [key, read, lockAttempt]);
  const update = useCallback(
    (change: Change, opts: { system?: boolean; group?: string } = {}) => {
      if (isBlocked()) return false;
      const patch =
        typeof change === 'function' ? change(current.current) : change;
      const next = { ...current.current, ...cloneCompose(patch) };
      if (equal(next, current.current)) return false;
      if (!opts.system) {
        job.current = null;
        const now = Date.now();
        if (
          !opts.group ||
          group.current.name !== opts.group ||
          now - group.current.time > 500
        )
          history.current.push(cloneCompose(current.current));
        group.current = { name: opts.group, time: now };
        future.current = [];
        touched.current = true;
      }
      current.current = next;
      if (!touched.current) saved.current = cloneCompose(next);
      else persist();
      render((value) => value + 1);
      return true;
    },
    [isBlocked, persist],
  );
  const moveHistory = useCallback(
    (from: ComposeDocument[], to: ComposeDocument[]) => {
      if (isBlocked()) return;
      const snapshot = from.pop();
      if (!snapshot) return;
      to.push(cloneCompose(current.current));
      current.current = snapshot;
      job.current = null;
      epoch.current++;
      touched.current = true;
      endGroup();
      persist();
      render((value) => value + 1);
    },
    [isBlocked, endGroup, persist],
  );
  const undo = useCallback(
    () => moveHistory(history.current, future.current),
    [moveHistory],
  );
  const redo = useCallback(
    () => moveHistory(future.current, history.current),
    [moveHistory],
  );
  const acceptExport = useCallback(
    (snapshot: ComposeDocument) => {
      if (isBlocked()) return false;
      try {
        writeComposeDraft(
          key,
          {
            version: 1,
            job: job.current,
            current: current.current,
            saved: snapshot,
            dirty: !equal(current.current, snapshot),
          },
          true,
        );
        saved.current = cloneCompose(snapshot);
        persistenceFailed.current = false;
        hasSaved.current = true;
        setError(null);
        endGroup();
        render((value) => value + 1);
        return true;
      } catch (cause) {
        persistenceFailed.current = true;
        setError(String(cause));
        render((value) => value + 1);
        return false;
      }
    },
    [key, isBlocked, endGroup],
  );
  const save = useCallback(
    async () => acceptExport(current.current),
    [acceptExport],
  );
  const discard = useCallback(() => {
    if (!ownsLock.current) return false;
    try {
      if (pending.current || readFailed.current) clearComposeDraft(key);
      else
        writeComposeDraft(
          key,
          {
            version: 1,
            job: job.current,
            current: saved.current,
            saved: saved.current,
            dirty: false,
          },
          true,
        );
    } catch (cause) {
      setError(String(cause));
      return false;
    }
    if (pending.current || readFailed.current) job.current = null;
    pending.current = null;
    readFailed.current = false;
    persistenceFailed.current = false;
    current.current = cloneCompose(saved.current);
    epoch.current++;
    history.current = [];
    future.current = [];
    endGroup();
    setError(null);
    render((value) => value + 1);
    return true;
  }, [key, endGroup]);
  const restore = useCallback(() => {
    if (!ownsLock.current) return;
    const draft = pending.current;
    if (!draft) return;
    current.current = cloneCompose(draft.current);
    saved.current = cloneCompose(draft.saved);
    touched.current = true;
    pending.current = null;
    epoch.current++;
    history.current = draft.dirty ? [cloneCompose(draft.saved)] : [];
    future.current = [];
    render((value) => value + 1);
  }, []);
  const setJob = useCallback(
    (reference: ComposeJobReference | null) => {
      if (isBlocked()) return false;
      job.current = reference;
      const success = persist();
      render((value) => value + 1);
      return success;
    },
    [isBlocked, persist],
  );
  return {
    value: current.current,
    current,
    job,
    setJob,
    update,
    undo,
    redo,
    save,
    acceptExport,
    discard,
    restore,
    retryRead: read,
    endGroup,
    ready,
    lockState,
    retryLock: () => setLockAttempt((value) => value + 1),
    recovery: pending.current,
    readFailed: readFailed.current,
    dirty: getIsDirty(),
    getIsDirty,
    isBlocked,
    error,
    canUndo: !!history.current.length,
    canRedo: !!future.current.length,
    touched,
    epoch,
    revision,
    hasSaved: hasSaved.current,
  };
}
