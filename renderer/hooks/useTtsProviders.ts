import { useCallback } from 'react';
import useProviderPersistence from './useProviderPersistence';
import {
  buildTtsInstanceFromPreset,
  getTtsProviderType,
  getTtsPresetsForType,
  nextTtsInstanceName,
  type TtsProvider,
} from '../../types/ttsProvider';

export interface TtsProvidersApi {
  persistence: ReturnType<typeof useProviderPersistence<TtsProvider>>;
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
 * 加载 / 字段更新（500ms debounce 全量写回）/ 增删（立即排队写回）/ 离开守卫。
 */
export default function useTtsProviders(): TtsProvidersApi {
  const persistence = useProviderPersistence<TtsProvider>('Tts');
  const { providers, loaded, change } = persistence;

  const updateInstanceField = useCallback(
    (id: string, key: string, value: string | number | boolean) => {
      change((prev) => {
        const next = prev.map((p) =>
          p.id === id ? { ...p, [key]: value } : p,
        );
        return next;
      });
    },
    [change],
  );

  /** 插入新实例：同类型内去重命名后置顶并立即持久化。 */
  const insertInstance = useCallback(
    (instance: TtsProvider) => {
      return change((prev) => {
        instance.name = nextTtsInstanceName(
          prev.filter((p) => p.type === instance.type),
          instance.name,
        );
        const next = [instance, ...prev];
        return next;
      }, 0);
    },
    [change],
  );

  const addInstance = useCallback(
    (typeId: string, presetId?: string): string | null => {
      const type = getTtsProviderType(typeId);
      if (!type) return null;
      const preset = presetId
        ? getTtsPresetsForType(typeId).find((p) => p.id === presetId)
        : undefined;
      const instance = buildTtsInstanceFromPreset(type, preset);
      return insertInstance(instance) ? instance.id : null;
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
      return insertInstance(instance) ? instance.id : null;
    },
    [insertInstance],
  );

  const removeInstance = useCallback(
    (id: string) => {
      change((prev) => {
        const next = prev.filter((p) => p.id !== id);
        return next;
      }, 0);
    },
    [change],
  );

  return {
    persistence,
    providers,
    loaded,
    updateInstanceField,
    addInstance,
    addCustomInstance,
    removeInstance,
  };
}
