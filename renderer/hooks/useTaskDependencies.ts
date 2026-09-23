import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoreType } from '../../main/helpers/store/types';
import type { ISystemInfo } from '../../types/types';
import type { Provider } from '../../types/provider';
import type { AsrProvider } from '../../types/asrProvider';
import { assertProviderList } from '../../types/providerPersistence';

const initial = {
  systemInfo: {
    modelsInstalled: [],
    modelsPath: '',
    downloadingModels: [],
  } as ISystemInfo,
  providers: [] as Provider[],
  asrProviders: [] as AsrProvider[],
  settings: {} as Partial<StoreType['settings']>,
};

/** Publish a complete dependency snapshot before correcting task selections. */
export default function useTaskDependencies() {
  const [data, setData] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const token = ++epoch.current;
    setLoading(true);
    setError(null);
    try {
      const [systemInfo, providers, asrProviders, settings] = await Promise.all(
        [
          window.ipc.invoke('getSystemInfo', null),
          window.ipc.invoke('getTranslationProviders'),
          window.ipc.invoke('getAsrProviders'),
          window.ipc.invoke('getSettings'),
        ],
      );
      assertProviderList(providers);
      assertProviderList(asrProviders);
      if (!systemInfo || !Array.isArray(systemInfo.modelsInstalled))
        throw new Error('INVALID_SYSTEM_INFO');
      if (!settings || typeof settings !== 'object' || Array.isArray(settings))
        throw new Error('INVALID_SETTINGS_RESPONSE');
      if (epoch.current !== token) return;
      setData({
        systemInfo,
        providers: providers as Provider[],
        asrProviders: asrProviders as AsrProvider[],
        settings,
      });
      setLoaded(true);
    } catch (cause) {
      if (epoch.current === token) {
        setLoaded(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (epoch.current === token) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
    };
  }, [load]);
  useEffect(
    () =>
      window.ipc?.on?.('assistant:event', (event: any) => {
        if (
          event.type === 'changed' &&
          /^(providers|settings|models|engines)\./.test(event.operation)
        )
          void load();
      }),
    [load],
  );
  return { ...data, loaded, loading, error, load };
}
