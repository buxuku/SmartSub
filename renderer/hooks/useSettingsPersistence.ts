import { useCallback, useEffect, useRef, useState } from 'react';
import { invalidVadSettings } from '../../types/vadSettings';
import { invalidEngineSettings } from '../../types/engineSettings';

type SettingsPatch = Record<string, unknown>;

/** Keep unacknowledged fields until their exact revision reaches settings storage. */
export function useSettingsPersistence(
  onLoaded: (settings: SettingsPatch) => void,
  onSaved?: (settings: SettingsPatch) => void,
) {
  const callback = useRef(onLoaded);
  callback.current = onLoaded;
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const alive = useRef(false);
  const epoch = useRef(0);
  const ready = useRef(false);
  const acknowledged = useRef<SettingsPatch>({});
  const pending = useRef(
    new Map<string, { value: unknown; revision: number }>(),
  );
  const revision = useRef(0);
  const flight = useRef<Promise<boolean> | null>(null);
  const discarding = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [, refresh] = useState(0);
  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const load = useCallback(async () => {
    if (!alive.current || pending.current.size || flight.current) return;
    const token = ++epoch.current;
    ready.current = false;
    setLoaded(false);
    setLoading(true);
    setLoadError('');
    try {
      const value = await window.ipc.invoke('getSettings');
      if (!alive.current || token !== epoch.current) return;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        'success' in value
      )
        throw new Error('INVALID_SETTINGS_RESPONSE');
      acknowledged.current = structuredClone(value);
      callback.current(structuredClone(value));
      ready.current = true;
      setError('');
      setLoaded(true);
    } catch (cause) {
      if (alive.current && token === epoch.current)
        setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current && token === epoch.current) setLoading(false);
    }
  }, []);
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
  useEffect(
    () =>
      window.ipc?.on?.('assistant:event', (event: any) => {
        if (event.type === 'changed' && event.operation === 'settings.update')
          void load();
      }),
    [load],
  );

  const getIsDirty = useCallback(() => pending.current.size > 0, []);
  const save = useCallback((): Promise<boolean> => {
    clearTimer();
    if (flight.current) return flight.current;
    if (!alive.current || !ready.current) return Promise.resolve(false);
    const token = epoch.current;
    const current = () => alive.current && token === epoch.current;
    const promise = (async () => {
      setSaving(true);
      setError('');
      try {
        while (pending.current.size) {
          const snapshot = new Map(pending.current);
          const patch = Object.fromEntries(
            Array.from(snapshot, ([key, entry]) => [key, entry.value]),
          );
          const invalid = invalidVadSettings(patch);
          if (invalid.length)
            throw new Error(`INVALID_VAD_SETTINGS: ${invalid.join(', ')}`);
          const invalidEngine = invalidEngineSettings(patch);
          if (invalidEngine.length)
            throw new Error(
              `INVALID_ENGINE_SETTINGS: ${invalidEngine.join(', ')}`,
            );
          const response = await window.ipc.invoke('setSettings', patch);
          if (!current()) return false;
          if (
            !response ||
            typeof response !== 'object' ||
            Array.isArray(response) ||
            !Array.isArray(response.rejectedKeys) ||
            response.rejectedKeys.some(
              (key: unknown) => typeof key !== 'string' || !snapshot.has(key),
            ) ||
            response.success === false
          )
            throw new Error(
              response?.error || 'INVALID_SETTINGS_SAVE_RESPONSE',
            );
          for (const [key, entry] of Array.from(snapshot)) {
            if (response.rejectedKeys.includes(key)) continue;
            acknowledged.current[key] = entry.value;
            if (pending.current.get(key)?.revision === entry.revision)
              pending.current.delete(key);
          }
          if (response.rejectedKeys.length)
            throw new Error(
              `SETTINGS_REJECTED: ${response.rejectedKeys.join(', ')}`,
            );
        }
        callback.current(structuredClone(acknowledged.current));
        savedCallback.current?.(structuredClone(acknowledged.current));
        return true;
      } catch (cause) {
        if (current())
          setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        if (current()) {
          setSaving(false);
          refresh((value) => value + 1);
        }
      }
    })();
    flight.current = promise;
    void promise.finally(() => {
      if (flight.current === promise) flight.current = null;
    });
    return promise;
  }, [clearTimer]);

  const stage = useCallback(
    (patch: SettingsPatch, delay: number | null = 500) => {
      if (!alive.current || !ready.current || discarding.current) return false;
      for (const [key, value] of Object.entries(patch))
        pending.current.set(key, {
          value: structuredClone(value),
          revision: ++revision.current,
        });
      refresh((value) => value + 1);
      clearTimer();
      if (delay !== null)
        timer.current = setTimeout(() => {
          void save();
        }, delay);
      return true;
    },
    [clearTimer, save],
  );
  const persist = useCallback(
    (patch: SettingsPatch) => {
      if (!stage(patch, null)) return Promise.resolve(false);
      return save();
    },
    [stage, save],
  );
  const discard = useCallback(async () => {
    discarding.current = true;
    clearTimer();
    pending.current.clear();
    // An accepted write cannot be rolled back by discarding its acknowledgement.
    if (flight.current) await flight.current;
    clearTimer();
    discarding.current = false;
    if (!alive.current) return true;
    callback.current(structuredClone(acknowledged.current));
    setError('');
    refresh((value) => value + 1);
    return true;
  }, [clearTimer]);
  return {
    loaded,
    loading,
    loadError,
    load,
    error,
    saving,
    isDirty: getIsDirty(),
    getIsDirty,
    stage,
    save,
    persist,
    discard,
  };
}
