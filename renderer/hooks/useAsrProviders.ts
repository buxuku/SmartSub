import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildInstanceFromPreset,
  getAsrProviderType,
  getAsrPresetsForType,
  nextInstanceName,
  type AsrProvider,
} from '../../types/asrProvider';

export interface AsrProvidersApi {
  /** 全量实例列表（单一事实源：左栏状态点与右栏面板共用）。 */
  providers: AsrProvider[];
  /** 首次 getAsrProviders 是否已返回（legacy 视图收敛等一次性逻辑据此触发）。 */
  loaded: boolean;
  /** 更新某实例的一个字段（debounce 持久化）。 */
  updateInstanceField: (
    id: string,
    key: string,
    value: string | number | boolean,
  ) => void;
  /**
   * 新建某类型实例（可选按预设预填），立即持久化并返回新实例 id；
   * 未知类型返回 null。带 presetId 时在实例上打 `presetId` 标记（侧栏预设槽位
   * 据此认领，改 URL 不漂移）。品牌型单例的「封顶 1」由调用方（面板形态）保证。
   */
  addInstance: (typeId: string, presetId?: string) => string | null;
  /**
   * 新建自定义实例（侧栏「添加自定义」入口）：用户命名 + 可选 Base URL 覆写，
   * 名称在同类型内自动去重（OpenAI → OpenAI 2…）。立即持久化并返回新实例 id。
   */
  addCustomInstance: (
    typeId: string,
    name: string,
    apiUrl?: string,
  ) => string | null;
  /** 删除实例（立即持久化）。 */
  removeInstance: (id: string) => void;
}

/**
 * 云端听写实例数组的单一持有者：加载 / 字段更新（500ms debounce 全量写回）/
 * 增删（立即写回）/ 卸载 flush。供 EngineModelTab 持有、面板经 props 消费
 * （见 redesign-engine-panel-layout）。
 */
export default function useAsrProviders(): AsrProvidersApi {
  const [providers, setProviders] = useState<AsrProvider[]>([]);
  const [loaded, setLoaded] = useState(false);

  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<AsrProvider[] | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = (await window?.ipc?.invoke('getAsrProviders')) || [];
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
      window?.ipc?.send('setAsrProviders', pendingRef.current);
      pendingRef.current = null;
    }
  }, []);

  useEffect(() => () => flushPersist(), [flushPersist]);

  const schedulePersist = useCallback((next: AsrProvider[]) => {
    pendingRef.current = next;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      if (pendingRef.current) {
        window?.ipc?.send('setAsrProviders', pendingRef.current);
        pendingRef.current = null;
      }
    }, 500);
  }, []);

  const persistNow = useCallback((next: AsrProvider[]) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    pendingRef.current = null;
    window?.ipc?.send('setAsrProviders', next);
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
    (instance: AsrProvider) => {
      setProviders((prev) => {
        instance.name = nextInstanceName(
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
      const type = getAsrProviderType(typeId);
      if (!type) return null;
      const preset = presetId
        ? getAsrPresetsForType(typeId).find((p) => p.id === presetId)
        : undefined;
      const instance = buildInstanceFromPreset(type, preset);
      // 预设槽位物化的实例打上来源标记，侧栏槽位据此稳定认领。
      if (preset) instance.presetId = preset.id;
      insertInstance(instance);
      return instance.id;
    },
    [insertInstance],
  );

  const addCustomInstance = useCallback(
    (typeId: string, name: string, apiUrl?: string): string | null => {
      const type = getAsrProviderType(typeId);
      if (!type) return null;
      const instance = buildInstanceFromPreset(type);
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
