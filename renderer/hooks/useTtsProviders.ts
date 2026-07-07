import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildTtsInstanceFromPreset,
  getTtsProviderType,
  getTtsPresetsForType,
  nextTtsInstanceName,
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
  /** 新建某类型实例（可选按预设预填），立即持久化并返回新实例 id。 */
  addInstance: (typeId: string, presetId?: string) => string | null;
  /** 新建自定义实例（用户命名 + 可选 Base URL），立即持久化并返回新实例 id。 */
  addCustomInstance: (
    typeId: string,
    name: string,
    apiUrl?: string,
  ) => string | null;
  removeInstance: (id: string) => void;
}

/**
 * 云端配音（TTS）实例数组的单一持有者（形制 useAsrProviders）：
 * 加载 / 字段更新（500ms debounce 全量写回）/ 增删（立即写回）/ 卸载 flush。
 */
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

  /** 插入新实例：同类型内去重命名后置顶并立即持久化。 */
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
      insertInstance(instance);
      return instance.id;
    },
    [insertInstance],
  );

  const addCustomInstance = useCallback(
    (typeId: string, name: string, apiUrl?: string): string | null => {
      const type = getTtsProviderType(typeId);
      if (!type) return null;
      const instance = buildTtsInstanceFromPreset(type);
      instance.name = name.trim() || type.name;
      if (apiUrl?.trim()) instance.apiUrl = apiUrl.trim();
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
    addCustomInstance,
    removeInstance,
  };
}
