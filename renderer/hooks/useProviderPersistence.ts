import { useCallback, useEffect, useRef, useState } from 'react';
import {
  assertProviderList,
  type ProviderRecord,
} from '../../types/providerPersistence';
import { useNavigationGuard } from '../context/NavigationGuardContext';

export type ProviderKind = 'Translation' | 'Asr' | 'Tts';

export interface ProviderTextDrafts<T extends ProviderRecord> {
  getDraft: (key: string) => string;
  stageDraft: (
    key: string,
    value: string,
    apply: (providers: T[]) => T[],
    retainEmpty?: boolean,
  ) => void;
  commitDraft: (key: string) => boolean;
}

export default function useProviderPersistence<T extends ProviderRecord>(
  kind: ProviderKind,
) {
  const [providers, setProviders] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const alive = useRef(false);
  const ready = useRef(false);
  const epoch = useRef(0);
  const revision = useRef(0);
  const current = useRef<T[]>([]);
  const acknowledged = useRef<T[]>([]);
  const pending = useRef(false);
  const drafts = useRef(
    new Map<
      string,
      {
        value: string;
        apply: (providers: T[]) => T[];
      }
    >(),
  );
  const [, refreshDrafts] = useState(0);
  const flight = useRef<Promise<boolean> | null>(null);
  const unacknowledged = useRef<{
    providers: T[];
    expectedProviders: T[];
    revision: number;
  } | null>(null);
  const discarding = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const getIsDirty = useCallback(
    () => pending.current || drafts.current.size > 0,
    [],
  );
  const getDraft = useCallback(
    (key: string) => drafts.current.get(key)?.value ?? '',
    [],
  );
  const getProviders = useCallback(() => current.current, []);
  const load = useCallback(async () => {
    if (!alive.current || getIsDirty() || flight.current) return false;
    const token = ++epoch.current;
    ready.current = false;
    setLoaded(false);
    setLoading(true);
    setLoadError('');
    try {
      const value = await window.ipc.invoke(`get${kind}Providers`);
      if (!alive.current || token !== epoch.current) return false;
      assertProviderList(value);
      current.current = structuredClone(value) as T[];
      acknowledged.current = structuredClone(value) as T[];
      unacknowledged.current = null;
      setProviders(current.current);
      ready.current = true;
      setLoaded(true);
      setError('');
      return true;
    } catch (cause) {
      if (alive.current && token === epoch.current)
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (alive.current && token === epoch.current) setLoading(false);
    }
  }, [kind, getIsDirty]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      ready.current = false;
      epoch.current++;
      clearTimer();
    };
  }, [load, clearTimer]);

  const persist = useCallback((): Promise<boolean> => {
    clearTimer();
    if (flight.current) return flight.current;
    if (!alive.current || !ready.current) return Promise.resolve(false);
    const token = epoch.current;
    const active = () => alive.current && token === epoch.current;
    const promise = (async () => {
      setSaving(true);
      setError('');
      try {
        while (pending.current) {
          // Replay the exact uncertain write before sending newer input; the backend
          // recognizes a committed request whose acknowledgement was lost.
          const request = unacknowledged.current ?? {
            providers: structuredClone(current.current),
            expectedProviders: structuredClone(acknowledged.current),
            revision: revision.current,
          };
          unacknowledged.current = request;
          const response = await window.ipc.invoke(`set${kind}Providers`, {
            providers: request.providers,
            expectedProviders: request.expectedProviders,
          });
          if (!active()) return false;
          if (response?.success !== true)
            throw new Error(
              response?.error || 'INVALID_PROVIDER_SAVE_RESPONSE',
            );
          acknowledged.current = request.providers;
          unacknowledged.current = null;
          if (request.revision === revision.current) pending.current = false;
        }
        return true;
      } catch (cause) {
        if (active())
          setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        if (active()) {
          setSaving(false);
          setDirty(getIsDirty());
        }
      }
    })();
    flight.current = promise;
    void promise.finally(() => {
      if (flight.current === promise) flight.current = null;
    });
    return promise;
  }, [kind, clearTimer, getIsDirty]);

  const change = useCallback(
    (update: T[] | ((previous: T[]) => T[]), delay = 500) => {
      if (!alive.current || !ready.current || discarding.current) return false;
      const next =
        typeof update === 'function'
          ? update(structuredClone(current.current))
          : update;
      assertProviderList(next);
      current.current = structuredClone(next);
      revision.current++;
      pending.current = true;
      setProviders(current.current);
      setDirty(true);
      clearTimer();
      timer.current = setTimeout(() => void persist(), delay);
      return true;
    },
    [clearTimer, persist],
  );

  const stageDraft = useCallback(
    (
      key: string,
      value: string,
      apply: (providers: T[]) => T[],
      retainEmpty = false,
    ) => {
      if (!alive.current || !ready.current || discarding.current) return;
      if (value || retainEmpty) drafts.current.set(key, { value, apply });
      else drafts.current.delete(key);
      setDirty(getIsDirty());
      refreshDrafts((version) => version + 1);
    },
    [getIsDirty],
  );

  const commitDraft = useCallback(
    (key: string) => {
      const draft = drafts.current.get(key);
      if (!draft) return true;
      try {
        if (!change(draft.apply)) return false;
        drafts.current.delete(key);
        refreshDrafts((version) => version + 1);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [change],
  );

  const save = useCallback(() => {
    // Explicit save includes unsubmitted tag inputs, including drafts on other panels.
    // Debounced writes only persist committed fields and never consume search input.
    for (const key of Array.from(drafts.current.keys())) {
      if (!commitDraft(key)) return Promise.resolve(false);
    }
    return persist();
  }, [commitDraft, persist]);

  const discard = useCallback(async () => {
    discarding.current = true;
    clearTimer();
    pending.current = false;
    drafts.current.clear();
    refreshDrafts((version) => version + 1);
    if (flight.current) await flight.current;
    unacknowledged.current = null;
    clearTimer();
    discarding.current = false;
    if (!alive.current) return true;
    current.current = structuredClone(acknowledged.current);
    setProviders(current.current);
    setDirty(false);
    setError('');
    return true;
  }, [clearTimer]);

  useNavigationGuard(`providers-${kind}`, {
    isDirty: dirty,
    getIsDirty,
    onSave: save,
    onDiscard: discard,
  });
  return {
    providers,
    loaded,
    loading,
    loadError,
    error,
    saving,
    isDirty: dirty,
    getIsDirty,
    getProviders,
    getDraft,
    stageDraft,
    commitDraft,
    load,
    save,
    change,
    discard,
  };
}
