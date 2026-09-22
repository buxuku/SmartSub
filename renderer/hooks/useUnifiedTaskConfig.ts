import { useState, useRef, useCallback, useEffect } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { isEqual } from 'lodash';
import { assertTaskConfig, omitTaskManuscript } from '../../types/taskConfig';
import {
  applyScenarioPreset,
  type ScenarioPresetId,
} from '../lib/scenarioPresets';
export { validateTaskConfigReady } from '../lib/taskReadiness';
export type { ValidationReadyResult } from '../lib/taskReadiness';

export interface UseUnifiedTaskConfigOptions {
  /** Project pages load their own snapshot before falling back to defaults. */
  autoLoad?: boolean;
  initialConfig?: Record<string, any>;
}

export function buildTaskSnapshotFromConfig(
  formData: Record<string, any> | undefined,
  extra?: Record<string, any>,
): Record<string, any> {
  return structuredClone({ ...formData, ...extra });
}

export async function readTaskDefaults(): Promise<Record<string, any>> {
  const config = await window.ipc.invoke('getUserConfig');
  assertTaskConfig(config);
  return omitTaskManuscript(config);
}

/** Task edits belong to a project/wizard draft, never to global preferences. */
export default function useUnifiedTaskConfig(
  options: UseUnifiedTaskConfigOptions = {},
) {
  const { autoLoad = true } = options;
  const initialConfig = useRef(
    buildTaskSnapshotFromConfig(options.initialConfig),
  );
  const form: UseFormReturn<any> = useForm({
    defaultValues: initialConfig.current,
  });
  const [formData, setFormData] = useState<Record<string, any>>(
    form.getValues(),
  );
  const formDataRef = useRef(formData);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(autoLoad);
  const [loadError, setLoadError] = useState('');
  const loadedRef = useRef(false);
  const aliveRef = useRef(false);
  const loadEpochRef = useRef(0);

  const hydrateSnapshot = useCallback(
    (snap: Record<string, any>) => {
      assertTaskConfig(snap);
      const snapshot = buildTaskSnapshotFromConfig(snap);
      // Invalidate both successful and failed responses from any earlier load.
      loadEpochRef.current++;
      loadedRef.current = false;
      form.reset(snapshot);
      formDataRef.current = buildTaskSnapshotFromConfig(snapshot);
      setFormData(formDataRef.current);
      loadedRef.current = true;
      setLoaded(true);
      setLoading(false);
      setLoadError('');
    },
    [form],
  );

  const load = useCallback(async () => {
    // A retry must never replace a hydrated project or subsequent user edits.
    if (!aliveRef.current || loadedRef.current) return false;
    const token = ++loadEpochRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const defaults = await readTaskDefaults();
      if (token !== loadEpochRef.current || !aliveRef.current) return false;
      hydrateSnapshot({ ...defaults, ...initialConfig.current });
      return true;
    } catch (cause) {
      if (token === loadEpochRef.current && aliveRef.current)
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (token === loadEpochRef.current && aliveRef.current) setLoading(false);
    }
  }, [hydrateSnapshot]);

  useEffect(() => {
    aliveRef.current = true;
    if (autoLoad) void load();
    return () => {
      aliveRef.current = false;
      loadEpochRef.current++;
    };
  }, [autoLoad, load]);

  useEffect(() => {
    const subscription = form.watch((values) => {
      if (!loadedRef.current || !aliveRef.current) return;
      if (!isEqual(values, formDataRef.current)) {
        // RHF can mutate nested values in place; draft snapshots must stay stable.
        formDataRef.current = buildTaskSnapshotFromConfig(values);
        setFormData(formDataRef.current);
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  const setValue = useCallback(
    (name: string, value: unknown, setOptions?: any) => {
      if (!loadedRef.current) return;
      form.setValue(name, value, {
        shouldDirty: true,
        shouldValidate: true,
        ...setOptions,
      });
    },
    [form],
  );

  const applyPreset = useCallback(
    (presetId: ScenarioPresetId) => {
      if (loadedRef.current) applyScenarioPreset(form, presetId);
    },
    [form],
  );

  const buildSnapshot = useCallback(
    (extra?: Record<string, any>) =>
      buildTaskSnapshotFromConfig(formDataRef.current, extra),
    [],
  );

  return {
    form,
    formData,
    loaded,
    loading,
    loadError,
    load,
    setValue,
    applyPreset,
    buildSnapshot,
    hydrateSnapshot,
  };
}
