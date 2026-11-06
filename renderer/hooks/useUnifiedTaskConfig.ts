import { useState, useRef, useCallback, useEffect } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { isEqual } from 'lodash';
import { assertTaskConfig, omitTaskManuscript } from '../../types/taskConfig';
import {
  applyScenarioPreset,
  type ScenarioPresetId,
} from '../lib/scenarioPresets';
import { createTaskDefaultsSync } from '../lib/taskDefaultsSync';
export { validateTaskConfigReady } from '../lib/taskReadiness';
export type { ValidationReadyResult } from '../lib/taskReadiness';

export interface UseUnifiedTaskConfigOptions {
  /** Project pages load their own snapshot before falling back to defaults. */
  autoLoad?: boolean;
  initialConfig?: Record<string, any>;
  /**
   * Task pages: remember what the user adjusts as the defaults of the next new task,
   * live ("last used"). Off for editors with their own draft semantics (the wizard).
   */
  syncDefaults?: boolean;
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

/**
 * Save the reusable settings the user just changed as defaults of the next new task.
 * Resolves only once the main process confirmed they are stored.
 */
export async function updateTaskDefaults(
  patch: Record<string, any>,
): Promise<void> {
  const result = await window.ipc.invoke('updateTaskDefaults', patch);
  if (result?.success !== true)
    throw new Error(result?.error || 'TASK_DEFAULTS_NOT_SAVED');
}

/**
 * A task's form belongs to its project/wizard draft: a failed read never publishes
 * defaults, and the wizard never writes global preferences. Task pages opt in to
 * `syncDefaults`, which saves what the user changes as the defaults of the next new task
 * (see `taskDefaultsSync` for what is and is not remembered).
 */
export default function useUnifiedTaskConfig(
  options: UseUnifiedTaskConfigOptions = {},
) {
  const { autoLoad = true, syncDefaults = false } = options;
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
  // Live "last used" memory of the task page; the option is read when an edit happens.
  const syncDefaultsRef = useRef(syncDefaults);
  syncDefaultsRef.current = syncDefaults;
  const syncRef = useRef<ReturnType<typeof createTaskDefaultsSync> | null>(
    null,
  );
  if (!syncRef.current)
    syncRef.current = createTaskDefaultsSync({ send: updateTaskDefaults });
  const sync = syncRef.current;

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
      // A loaded form is a new session: what it holds is not a user edit, and the edits
      // the previous one still had pending are saved first.
      sync.start(formDataRef.current);
      loadedRef.current = true;
      setLoaded(true);
      setLoading(false);
      setLoadError('');
    },
    [form, sync],
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
        if (syncDefaultsRef.current) sync.edit(formDataRef.current);
      }
    });
    return () => subscription.unsubscribe();
  }, [form, sync]);

  // Leaving the page or closing the window must not lose the last edit to the debounce.
  useEffect(() => {
    const flush = () => {
      void sync.flush();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [sync]);

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

  /**
   * Change a top-level value because the code decided to (healing a stale selection),
   * not because the user chose it: it is never remembered as a default.
   */
  const correctValue = useCallback(
    (name: string, value: unknown) => {
      if (!loadedRef.current) return;
      // Baseline first: the watch callback runs synchronously inside setValue.
      sync.correct(name, value);
      form.setValue(name, value);
    },
    [form, sync],
  );

  /** Save pending default edits now; resolves once they are saved (or have failed). */
  const flushDefaults = useCallback(() => sync.flush(), [sync]);

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
    correctValue,
    flushDefaults,
    applyPreset,
    buildSnapshot,
    hydrateSnapshot,
  };
}
