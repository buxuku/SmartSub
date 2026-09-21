import { useEffect } from 'react';
import { dubbingCueDraftKey } from '../../types/dubbingCueDraft';
import { dubbingConfigDraftKey } from '../lib/dubbingConfigDraft';

export function useDubbingDraftCleanup() {
  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout>;
    const clear = (ids: string[]) => {
      if (!active) return;
      for (const id of ids) {
        try {
          localStorage.removeItem(dubbingCueDraftKey(id));
          localStorage.removeItem(dubbingConfigDraftKey(id));
        } catch {
          /* Keep inaccessible storage for a future startup retry. */
        }
      }
    };
    const reconcile = async () => {
      try {
        const ids = new Set<string>();
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index) || '';
          for (const prefix of [
            dubbingCueDraftKey(''),
            dubbingConfigDraftKey(''),
          ])
            if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
        }
        if (ids.size)
          clear(
            await window.ipc.invoke('dubbing:missingSessions', Array.from(ids)),
          );
      } catch {
        if (active) retry = setTimeout(() => void reconcile(), 1000);
      }
    };
    const unsubscribe = window.ipc?.on('dubbing:sessionsDeleted', clear);
    void reconcile();
    return () => {
      active = false;
      clearTimeout(retry);
      unsubscribe?.();
    };
  }, []);
}
