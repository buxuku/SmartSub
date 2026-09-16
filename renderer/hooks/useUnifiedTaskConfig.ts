import { useState, useRef, useCallback, useEffect } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { isEqual } from 'lodash';
import store from '../lib/store';
import { omitTaskManuscript } from '../../types/taskConfig';
import {
  applyScenarioPreset,
  type ScenarioPresetId,
} from '../lib/scenarioPresets';
import type { TaskTypeDef } from '../lib/taskTypes';

export interface UseUnifiedTaskConfigOptions {
  taskType?: string;
  persistToGlobal?: boolean;
  initialConfig?: Record<string, any>;
}

export function buildTaskSnapshotFromConfig(
  formData: Record<string, any> | undefined,
  extra?: Record<string, any>,
): Record<string, any> {
  const base = formData ? { ...formData } : {};
  return {
    ...base,
    ...(extra || {}),
  };
}

export interface ValidationReadyResult {
  valid: boolean;
  errors: string[];
}

export function validateTaskConfigReady({
  files,
  typeDef,
  formData,
  systemInfo,
  providers,
}: {
  files: any[];
  typeDef: TaskTypeDef;
  formData: Record<string, any>;
  systemInfo?: any;
  providers?: any[];
  asrProviders?: any[];
}): ValidationReadyResult {
  const errors: string[] = [];

  if (!files || files.length === 0) {
    errors.push('files_required');
  }

  if (typeDef.needsModel) {
    const engine = formData?.transcriptionEngine;
    const model = formData?.model;
    if (engine !== 'parakeet' && !model) {
      errors.push('model_required');
    }
  }

  if (typeDef.hasTranslate) {
    if (!formData?.targetLanguage) {
      errors.push('target_language_required');
    }
    const provider = formData?.translateProvider;
    if (!provider || provider === '-1') {
      errors.push('provider_required');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export default function useUnifiedTaskConfig(
  options: UseUnifiedTaskConfigOptions = {},
) {
  const { persistToGlobal = false, initialConfig } = options;
  const form: UseFormReturn<any> = useForm({
    defaultValues: initialConfig || {},
  });

  const [formData, setFormData] = useState<Record<string, any>>(
    form.getValues(),
  );
  const formDataRef = useRef(formData);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const persistedConfig =
          (await window?.ipc?.invoke('getUserConfig')) || {};
        const storeUserConfig = omitTaskManuscript(persistedConfig);

        if (persistToGlobal && !isEqual(storeUserConfig, persistedConfig)) {
          window?.ipc?.send('setUserConfig', storeUserConfig);
          store.setItem('userConfig', storeUserConfig);
        }

        const mergedConfig = {
          ...storeUserConfig,
          ...(initialConfig || {}),
        };

        if (!cancelled) {
          form.reset(mergedConfig);
          setFormData(mergedConfig);
          formDataRef.current = mergedConfig;
          setLoaded(true);
        }
      } catch (err) {
        console.error(
          'Failed to load userConfig in useUnifiedTaskConfig:',
          err,
        );
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [persistToGlobal]);

  const handleFormChange = useCallback(
    (values: Record<string, any>) => {
      if (!isEqual(values, formDataRef.current)) {
        formDataRef.current = values;
        setFormData(values);

        if (persistToGlobal) {
          const persistedValues = omitTaskManuscript(values);
          window?.ipc?.send('setUserConfig', persistedValues);
          store.setItem('userConfig', persistedValues);
        }
      }
    },
    [persistToGlobal],
  );

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
  };
}
