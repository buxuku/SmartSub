import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildTtsInstanceFromPreset,
  getTtsProviderType,
  getTtsPresetsForType,
  nextTtsInstanceName,
  TTS_OPENAI_COMPATIBLE,
  type TtsProvider,
} from '../../types/ttsProvider';

export interface TtsProvidersApi {
  providers: TtsProvider[];
  loaded: boolean;
  updateInstanceField: (
    id: string,
    key: string,
    value: string | number | boolean,
  ) => void;
  addInstance: (typeId: string, presetId?: string) => string | null;
  removeInstance: (id: string) => void;
}

export default function useTtsProviders(): TtsProvidersApi {
  const [providers, setProviders] = useState<TtsProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<TtsProvider[] | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = (await window?.ipc?.invoke('getTtsProviders')) || [];
        if (Array.isArray(raw)) setProviders(raw);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (pendingRef.current) {
      window?.ipc?.send('setTtsProviders', pendingRef.current);
      pendingRef.current = null;
    }
  }, []);

  useEffect(() => () => flushPersist(), [flushPersist]);

  const schedulePersist = useCallback((next: TtsProvider[]) => {
    pendingRef.current = next;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      if (pendingRef.current) {
        window?.ipc?.send('setTtsProviders', pendingRef.current);
        pendingRef.current = null;
      }
    }, 500);
  }, []);

  const persistNow = useCallback((next: TtsProvider[]) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    pendingRef.current = null;
    window?.ipc?.send('setTtsProviders', next);
  }, []);

  const updateInstanceField = useCallback(
    (id: string, key: string, value: string | number | boolean) => {
      setProviders((prev) => {
        const next = prev.map((p) =>
          p.id === id ? { ...p, [key]: value } : p,
        );
        schedulePersist(next);
        return next;
      });
    },
    [schedulePersist],
  );

  const insertInstance = useCallback(
    (instance: TtsProvider) => {
      setProviders((prev) => {
        instance.name = nextTtsInstanceName(
          prev.filter((p) => p.type === instance.type),
          instance.name,
        );
        const next = [instance, ...prev];
        persistNow(next);
        return next;
      });
    },
    [persistNow],
  );

  const addInstance = useCallback(
    (typeId: string, presetId?: string): string | null => {
      const type = getTtsProviderType(typeId);
      if (!type) return null;
      const preset = presetId
        ? getTtsPresetsForType(typeId).find((p) => p.id === presetId)
        : undefined;
      const instance = buildTtsInstanceFromPreset(type, preset);
      if (preset) instance.presetId = preset.id;
      insertInstance(instance);
      return instance.id;
    },
    [insertInstance],
  );

  const removeInstance = useCallback(
    (id: string) => {
      setProviders((prev) => {
        const next = prev.filter((p) => p.id !== id);
        persistNow(next);
        return next;
      });
    },
    [persistNow],
  );

  return {
    providers,
    loaded,
    updateInstanceField,
    addInstance,
    removeInstance,
  };
}

export function ensureDefaultTtsProvider(
  api: TtsProvidersApi,
): TtsProvider | undefined {
  if (!api.loaded) return undefined;
  if (api.providers.length > 0) return api.providers[0];
  const id = api.addInstance(TTS_OPENAI_COMPATIBLE, 'openai');
  return id ? api.providers.find((p) => p.id === id) : undefined;
}
