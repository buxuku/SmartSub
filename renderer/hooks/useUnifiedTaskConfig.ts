import { useState, useRef, useCallback, useEffect } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { isEqual } from 'lodash';
import store from '../lib/store';
import { omitTaskManuscript } from '../../types/taskConfig';
import {
  applyScenarioPreset,
  type ScenarioPresetId,
} from '../lib/scenarioPresets';
export { validateTaskConfigReady } from '../lib/taskReadiness';
export type { ValidationReadyResult } from '../lib/taskReadiness';

export interface UseUnifiedTaskConfigOptions {
  taskType?: string;
  persistToGlobal?: boolean;
  initialConfig?: Record<string, any>;
}

export function buildTaskSnapshotFromConfig(
  formData: Record<string, any> | undefined,
  extra?: Record<string, any>,
): Record<string, any> {
  const base = formData || {};
  return structuredClone({
    ...base,
    ...(extra || {}),
  });
}

export default function useUnifiedTaskConfig(
  options: UseUnifiedTaskConfigOptions = {},
) {
  const { persistToGlobal = false, initialConfig } = options;
  const persistToGlobalRef = useRef(persistToGlobal);
  useEffect(() => {
    persistToGlobalRef.current = persistToGlobal;
  }, [persistToGlobal]);

  const form: UseFormReturn<any> = useForm({
    defaultValues: initialConfig || {},
  });

  const [formData, setFormData] = useState<Record<string, any>>(
    form.getValues(),
  );
  const formDataRef = useRef(formData);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const snapshotHydratedRef = useRef(false);

  const hydrateSnapshot = useCallback(
    (snap: Record<string, any>) => {
      snapshotHydratedRef.current = true;
      const snapshot = buildTaskSnapshotFromConfig(snap);
      form.reset(snapshot);
      setFormData(snapshot);
      formDataRef.current = snapshot;
      loadedRef.current = true;
      setLoaded(true);
    },
    [form],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const persistedConfig =
          (await window?.ipc?.invoke('getUserConfig')) || {};
        const storeUserConfig = omitTaskManuscript(persistedConfig);

        if (
          persistToGlobalRef.current &&
          !isEqual(storeUserConfig, persistedConfig)
        ) {
          window?.ipc?.send('setUserConfig', storeUserConfig);
          store.setItem('userConfig', storeUserConfig);
        }

        const mergedConfig = {
          ...storeUserConfig,
          ...(initialConfig || {}),
        };

        if (!cancelled) {
          if (!snapshotHydratedRef.current) {
            form.reset(mergedConfig);
            setFormData(mergedConfig);
            formDataRef.current = mergedConfig;
          }
          loadedRef.current = true;
          setLoaded(true);
        }
      } catch (err) {
        console.error(
          'Failed to load userConfig in useUnifiedTaskConfig:',
          err,
        );
        if (!cancelled) {
          loadedRef.current = true;
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleFormChange = useCallback((values: Record<string, any>) => {
    if (!loadedRef.current) return;
    if (!isEqual(values, formDataRef.current)) {
      formDataRef.current = values;
      setFormData(values);

      if (persistToGlobalRef.current) {
        const persistedValues = omitTaskManuscript(values);
        window?.ipc?.send('setUserConfig', persistedValues);
        store.setItem('userConfig', persistedValues);
      }
    }
  }, []);

  useEffect(() => {
    const subscription = form.watch(handleFormChange);
    return () => subscription.unsubscribe();
  }, [form, handleFormChange]);

  const setValue = useCallback(
    (name: string, value: unknown, setOptions?: any) => {
      form.setValue(name, value, {
        shouldDirty: true,
        shouldValidate: true,
        ...(setOptions || {}),
      });
    },
    [form],
  );

  const applyPreset = useCallback(
    (presetId: ScenarioPresetId) => {
      applyScenarioPreset(form, presetId);
    },
    [form],
  );

  const buildSnapshot = useCallback(
    (extra?: Record<string, any>) => {
      return buildTaskSnapshotFromConfig(formData, extra);
    },
    [formData],
  );

  return {
    form,
    formData,
    loaded,
    setValue,
    applyPreset,
    buildSnapshot,
    hydrateSnapshot,
  };
}
