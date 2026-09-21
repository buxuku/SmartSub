import { useCallback, useEffect, useRef, useState } from 'react';

type Invoke = (channel: string, payload?: any) => Promise<any>;

/** One user import/selection at a time, with retry and unmount isolation. */
export function useProofreadAction() {
  const alive = useRef(false);
  const version = useRef(0);
  const busyRef = useRef(false);
  const retryRef = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    busyRef.current = false;
    return () => {
      alive.current = false;
      version.current++;
    };
  }, []);
  const run = useCallback(
    async <T>(
      work: (invoke: Invoke) => Promise<T>,
      commit: (value: T) => void,
    ): Promise<void> => {
      if (!alive.current || busyRef.current) return;
      const token = ++version.current;
      const current = () => alive.current && token === version.current;
      busyRef.current = true;
      setBusy(true);
      setError('');
      retryRef.current = () => {
        void run(work, commit);
      };
      try {
        const invoke: Invoke = async (channel, payload) => {
          if (!current()) throw new Error('STALE_PROOFREAD_ACTION');
          const result = await window.ipc.invoke(channel, payload);
          if (!current()) throw new Error('STALE_PROOFREAD_ACTION');
          return result;
        };
        const result = await work(invoke);
        if (current()) {
          commit(result);
          retryRef.current = null;
        }
      } catch (reason) {
        if (current())
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (current()) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [],
  );
  return { busy, error, run, retry: () => retryRef.current?.() };
}
