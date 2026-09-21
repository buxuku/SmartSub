import { useRef, useState } from 'react';
import { useNavigationGuard } from '../context/NavigationGuardContext';
import type { DubbingCueView, DubbingSessionView } from '../../types/dubbing';
import {
  dubbingCueDraftKey,
  parseDubbingCueDraft,
  type DubbingCueDraft,
  type DubbingCueTextEdit,
} from '../../types/dubbingCueDraft';

type Lease = { sessionId: string; leaseId: string };
type Recovery = DubbingCueDraft | 'unreadable' | null;
type Journal = Lease & {
  local: string | null;
  disk: string | null;
  localRead: boolean;
  diskRead: boolean;
  revision: number;
  queue: Promise<unknown>;
  uncertain?: { raw: string | null };
};

export function useDubbingCueDrafts(options: {
  owns: (leaseId: string) => boolean;
  busy: () => boolean;
  acquire: () => void;
  release: () => void;
  apply: (view: DubbingSessionView) => void;
}) {
  const context = useRef(options);
  context.current = options;
  const journal = useRef<Journal | null>(null);
  const entriesRef = useRef<Record<number, DubbingCueTextEdit>>({});
  const [entries, setEntries] = useState(entriesRef.current);
  const recoveryRef = useRef<Recovery>(null);
  const [recovery, setRecoveryState] = useState<Recovery>(null);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const unconfirmed = useRef(new Set<number>());
  const journalPending = useRef(false);
  const [, refresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const isCurrent = (entry: Journal) =>
    journal.current === entry && context.current.owns(entry.leaseId);
  const setRecovery = (value: Recovery) => {
    recoveryRef.current = value;
    setRecoveryState(value);
  };
  const updateEntries = (value: Record<number, DubbingCueTextEdit>) => {
    entriesRef.current = value;
    setEntries(value);
  };
  const writeLocal = (entry: Journal, raw: string | null) => {
    if (!entry.localRead)
      throw new Error('Read the text draft before replacing it');
    const key = dubbingCueDraftKey(entry.sessionId);
    if (localStorage.getItem(key) !== entry.local)
      throw new Error('Text draft changed in another editor');
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
    entry.local = raw;
  };
  const writeDisk = (entry: Journal, raw: string | null) => {
    const operation = entry.queue
      .catch(() => {})
      .then(async () => {
        if (!isCurrent(entry) || !entry.diskRead)
          throw new Error('Text draft is not owned by this editor');
        if (entry.uncertain) {
          const check = await window.ipc.invoke('dubbing:readCueDraft', {
            sessionId: entry.sessionId,
            leaseId: entry.leaseId,
          });
          if (!check?.success)
            throw new Error(check?.error || 'Text draft read failed');
          if (check.data === entry.uncertain.raw) entry.disk = check.data;
          else if (check.data !== entry.disk)
            throw new Error('Text draft changed in another editor');
          entry.uncertain = undefined;
        }
        try {
          const result = await window.ipc.invoke('dubbing:writeCueDraft', {
            sessionId: entry.sessionId,
            leaseId: entry.leaseId,
            expected: entry.disk,
            raw,
          });
          if (!result?.success || result.data !== raw)
            throw new Error(result?.error || 'Text draft write failed');
          entry.disk = raw;
        } catch (failure) {
          entry.uncertain = { raw };
          const check = await window.ipc.invoke('dubbing:readCueDraft', {
            sessionId: entry.sessionId,
            leaseId: entry.leaseId,
          });
          if (check?.success && check.data === raw) {
            entry.disk = raw;
            entry.uncertain = undefined;
            return;
          }
          throw failure;
        }
      });
    entry.queue = operation;
    return operation;
  };
  const persist = async (
    entry: Journal,
    values: Record<number, DubbingCueTextEdit>,
  ) => {
    const raw = Object.keys(values).length
      ? JSON.stringify({
          version: 1,
          sessionId: entry.sessionId,
          revision: ++entry.revision,
          entries: Object.values(values),
        } satisfies DubbingCueDraft)
      : null;
    let localError: unknown;
    try {
      writeLocal(entry, raw);
    } catch (failure) {
      localError = failure;
    }
    await writeDisk(entry, raw);
    if (localError) throw localError;
  };
  const inspect = async (lease: Lease) => {
    const entry: Journal = {
      ...lease,
      local: null,
      disk: null,
      localRead: false,
      diskRead: false,
      revision: 0,
      queue: Promise.resolve(),
    };
    journal.current = entry;
    unconfirmed.current.clear();
    updateEntries({});
    setRecovery('unreadable');
    setError(null);
    try {
      const result = await window.ipc.invoke('dubbing:readCueDraft', lease);
      if (!isCurrent(entry)) return false;
      if (
        !result?.success ||
        !(result.data === null || typeof result.data === 'string')
      )
        throw new Error(result?.error || 'Text draft read failed');
      entry.disk = result.data;
      entry.diskRead = true;
      entry.local = localStorage.getItem(dubbingCueDraftKey(lease.sessionId));
      entry.localRead = true;
      const disk =
        entry.disk !== null
          ? parseDubbingCueDraft(entry.disk, lease.sessionId)
          : null;
      const local =
        entry.local !== null
          ? parseDubbingCueDraft(entry.local, lease.sessionId)
          : null;
      const selected =
        local && (!disk || local.revision > disk.revision) ? local : disk;
      entry.revision = selected?.revision || 0;
      setRecovery(selected);
      return true;
    } catch (failure) {
      if (isCurrent(entry)) setError(String(failure));
      return false;
    }
  };
  const blocked = () =>
    working.current ||
    journalPending.current ||
    !!recoveryRef.current ||
    Object.keys(entriesRef.current).length > 0;
  const edit = (cue: DubbingCueView, text: string) => {
    const entry = journal.current;
    if (
      !entry ||
      !isCurrent(entry) ||
      recoveryRef.current ||
      working.current ||
      context.current.busy()
    )
      return false;
    const previous = entriesRef.current[cue.index];
    const next = { ...entriesRef.current };
    // Keep the original comparison base until a successful save or explicit discard.
    next[cue.index] = {
      index: cue.index,
      startMs: previous?.startMs ?? cue.startMs,
      endMs: previous?.endMs ?? cue.endMs,
      baseText: previous?.baseText ?? cue.text,
      text,
    };
    if (
      !unconfirmed.current.has(cue.index) &&
      text === next[cue.index].baseText &&
      text === cue.text
    )
      delete next[cue.index];
    updateEntries(next);
    journalPending.current = true;
    void persist(entry, next)
      .then(() => {
        if (isCurrent(entry) && entriesRef.current === next) {
          journalPending.current = false;
          setError(null);
          refresh((value) => value + 1);
        }
      })
      .catch((failure) => {
        if (isCurrent(entry)) setError(String(failure));
      });
    return true;
  };
  const transact = async (save: boolean, index?: number) => {
    const entry = journal.current;
    if (
      !entry ||
      !isCurrent(entry) ||
      working.current ||
      context.current.busy() ||
      (save && recoveryRef.current)
    )
      return false;
    working.current = true;
    setSaving(true);
    context.current.acquire();
    setError(null);
    try {
      if (!entry.localRead || !entry.diskRead)
        throw new Error('Retry reading the text draft first');
      const all = entriesRef.current;
      const selected = Object.values(all).filter(
        (item) => index === undefined || item.index === index,
      );
      if (save && selected.length) {
        await persist(entry, all);
        for (const item of selected) unconfirmed.current.add(item.index);
        const result = await window.ipc.invoke('dubbing:saveCueTexts', {
          sessionId: entry.sessionId,
          leaseId: entry.leaseId,
          edits: selected,
        });
        if (!isCurrent(entry)) return false;
        if (
          !result?.success ||
          result.data?.sessionId !== entry.sessionId ||
          !Array.isArray(result.data?.cues)
        )
          throw new Error(result?.error || 'Text save failed');
        context.current.apply(result.data);
      }
      if (!save) {
        const current = await window.ipc.invoke('dubbing:getSession', {
          sessionId: entry.sessionId,
        });
        if (!isCurrent(entry)) return false;
        if (
          !current?.success ||
          current.data?.sessionId !== entry.sessionId ||
          !Array.isArray(current.data?.cues)
        )
          throw new Error(current?.error || 'Saved text could not be read');
        context.current.apply(current.data);
      }
      const next = { ...all };
      for (const item of selected) delete next[item.index];
      // Clear durable state before reporting success. Failed cleanup remains retryable.
      await persist(entry, next);
      if (!isCurrent(entry)) return false;
      updateEntries(next);
      for (const item of selected) unconfirmed.current.delete(item.index);
      journalPending.current = false;
      setRecovery(null);
      return true;
    } catch (failure) {
      if (isCurrent(entry)) {
        setError(String(failure));
        // A failed reply can follow a successful commit. Refresh only the saved
        // snapshot; keep every draft and its original comparison base intact.
        if (save) {
          try {
            const current = await window.ipc.invoke('dubbing:getSession', {
              sessionId: entry.sessionId,
            });
            if (
              isCurrent(entry) &&
              current?.success &&
              current.data?.sessionId === entry.sessionId &&
              Array.isArray(current.data?.cues)
            )
              context.current.apply(current.data);
          } catch {
            /* The original error and recovery journal remain visible. */
          }
        }
      }
      return false;
    } finally {
      working.current = false;
      context.current.release();
      if (isCurrent(entry)) setSaving(false);
    }
  };
  const save = (index?: number) => transact(true, index);
  const discard = (index?: number) => transact(false, index);
  const rebase = (cue: DubbingCueView) => {
    const draft = entriesRef.current[cue.index];
    if (
      !draft ||
      working.current ||
      recoveryRef.current ||
      context.current.busy()
    )
      return false;
    const entry = journal.current;
    if (!entry || !isCurrent(entry)) return false;
    const next = {
      ...entriesRef.current,
      [cue.index]: {
        ...draft,
        baseText: cue.text,
        startMs: cue.startMs,
        endMs: cue.endMs,
      },
    };
    updateEntries(next);
    journalPending.current = true;
    void persist(entry, next)
      .then(() => {
        if (isCurrent(entry) && entriesRef.current === next) {
          journalPending.current = false;
          setError(null);
          refresh((value) => value + 1);
        }
      })
      .catch((failure) => {
        if (isCurrent(entry)) setError(String(failure));
      });
    return true;
  };
  const restore = () => {
    const draft = recoveryRef.current;
    if (
      !draft ||
      draft === 'unreadable' ||
      working.current ||
      context.current.busy()
    )
      return false;
    updateEntries(
      Object.fromEntries(draft.entries.map((item) => [item.index, item])),
    );
    unconfirmed.current = new Set(draft.entries.map((item) => item.index));
    setRecovery(null);
    setError(null);
    return true;
  };
  const retry = () => {
    const entry = journal.current;
    return entry && !working.current && recoveryRef.current
      ? inspect(entry)
      : Promise.resolve(false);
  };
  const reset = () => {
    journal.current = null;
    unconfirmed.current.clear();
    journalPending.current = false;
    updateEntries({});
    setRecovery(null);
    setError(null);
  };
  useNavigationGuard('dubbing-cue-text', {
    isDirty: blocked(),
    getIsDirty: blocked,
    onSave: () => save(),
    onDiscard: () => discard(),
  });
  return {
    entries,
    recovery,
    error,
    saving,
    blocked,
    edit,
    save,
    discard,
    rebase,
    restore,
    retry,
    inspect,
    reset,
  };
}
