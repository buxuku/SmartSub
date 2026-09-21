import { useCallback, useEffect, useRef, useState } from 'react';

/** Keep a failed engine command retryable with its original source and variant. */
export default function useEngineOperation() {
  const epoch = useRef(0);
  const alive = useRef(false);
  const busyRef = useRef(false);
  const retryRef = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    busyRef.current = false;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  const run = useCallback(
    async <T>(work: () => Promise<T>, commit: (result: T) => void) => {
      if (!alive.current || busyRef.current) return false;
      const token = ++epoch.current;
      const active = () => alive.current && epoch.current === token;
      busyRef.current = true;
      setBusy(true);
      setError('');
      retryRef.current = () => {
        void run(work, commit);
      };
      try {
        const result = await work();
        if (!active()) return false;
        commit(result);
        retryRef.current = null;
        return true;
      } catch (cause) {
        if (active())
          setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        if (active()) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [],
  );
  return { busy, error, run, retry: () => retryRef.current?.() };
}
