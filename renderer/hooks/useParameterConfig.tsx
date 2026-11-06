import { useState, useEffect, useCallback, useRef } from 'react';
import { isEqual } from 'lodash';
import type {
  CustomParameterConfig,
  ParameterValue,
  ValidationError,
  ParameterDefinition,
} from '../../types/provider';

export interface ParameterConfigState {
  config: CustomParameterConfig | null;
  isLoading: boolean;
  hasUnsavedChanges: boolean;
  validationErrors: ValidationError[];
  lastSaved: number | null;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveMessage?: string;
  providerId?: string;
  loadError?: string;
}

export interface UseParameterConfigReturn {
  state: ParameterConfigState;
  loadConfig: (providerId: string) => Promise<void>;
  saveConfig: (
    providerId: string,
    config: CustomParameterConfig,
  ) => Promise<boolean>;
  resetConfig: (providerId: string) => Promise<boolean>;
  addHeaderParameter: (key: string, value: ParameterValue) => void;
  updateHeaderParameter: (key: string, value: ParameterValue) => void;
  removeHeaderParameter: (key: string) => void;
  addBodyParameter: (key: string, value: ParameterValue) => void;
  updateBodyParameter: (key: string, value: ParameterValue) => void;
  removeBodyParameter: (key: string) => void;
  validateConfiguration: (
    providerId: string,
    config?: CustomParameterConfig,
  ) => Promise<ValidationError[]>;
  getSupportedParameters: (
    providerId: string,
  ) => Promise<ParameterDefinition[]>;
  getParameterDefinition: (
    parameterKey: string,
  ) => Promise<ParameterDefinition | null>;
  exportConfiguration: () => string | null;
  importConfiguration: (jsonString: string) => boolean;
  enableAutoSave: (providerId: string, intervalMs?: number) => void;
  disableAutoSave: () => void;
  getIsDirty: () => boolean;
  flush: () => Promise<boolean>;
  discardChanges: () => void;
  getMigrationStatus: (providerId: string) => Promise<any>;
  getAppliedMigrations: () => Promise<any[]>;
  getAvailableMigrations: () => Promise<any[]>;
}

const emptyConfig = (): CustomParameterConfig => ({
  headerParameters: {},
  bodyParameters: {},
  configVersion: '1.0.0',
  lastModified: Date.now(),
});
const validConfig = (value: any): value is CustomParameterConfig =>
  Boolean(
    value &&
      typeof value.configVersion === 'string' &&
      Number.isFinite(value.lastModified) &&
      value.headerParameters &&
      typeof value.headerParameters === 'object' &&
      !Array.isArray(value.headerParameters) &&
      value.bodyParameters &&
      typeof value.bodyParameters === 'object' &&
      !Array.isArray(value.bodyParameters),
  );

export function useParameterConfig(): UseParameterConfigReturn {
  const [state, setState] = useState<ParameterConfigState>({
    config: null,
    isLoading: false,
    hasUnsavedChanges: false,
    validationErrors: [],
    lastSaved: null,
    saveStatus: 'idle',
  });
  const stateRef = useRef(state);
  const provider = useRef<string | null>(null);
  const loadVersion = useRef(0);
  const autoSave = useRef(true);
  const delay = useRef(2000);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const editSession = useRef(0);
  const baseline = useRef<CustomParameterConfig | null>(null);
  const publish = useCallback((patch: Partial<ParameterConfigState>) => {
    stateRef.current = { ...stateRef.current, ...patch };
    if (mounted.current) setState(stateRef.current);
  }, []);
  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const fail = useCallback(
    (cause: unknown) => {
      publish({
        isLoading: false,
        saveStatus: 'error',
        saveMessage: cause instanceof Error ? cause.message : String(cause),
      });
    },
    [publish],
  );

  const saveConfig = useCallback(
    (id: string, config: CustomParameterConfig): Promise<boolean> => {
      const snapshot = structuredClone(config);
      const session = editSession.current;
      const save = async () => {
        if (session !== editSession.current) return false;
        if (provider.current === id)
          publish({ saveStatus: 'saving', saveMessage: undefined });
        try {
          const result = await window?.ipc?.invoke(
            'config-manager:save',
            id,
            snapshot,
          );
          if (result?.success !== true)
            throw new Error(result?.error || 'Failed to save configuration');
          if (session !== editSession.current) return true;
          if (provider.current === id) baseline.current = snapshot;
          if (
            provider.current === id &&
            isEqual(stateRef.current.config, snapshot)
          ) {
            publish({
              hasUnsavedChanges: false,
              isLoading: false,
              lastSaved: Date.now(),
              saveStatus: 'saved',
              saveMessage: undefined,
              validationErrors: [],
            });
            if (statusTimer.current) clearTimeout(statusTimer.current);
            if (mounted.current)
              statusTimer.current = setTimeout(() => {
                if (
                  provider.current === id &&
                  stateRef.current.saveStatus === 'saved'
                )
                  publish({ saveStatus: 'idle' });
              }, 3000);
          } else if (provider.current === id) publish({ saveStatus: 'idle' });
          return true;
        } catch (error) {
          if (session === editSession.current && provider.current === id)
            fail(error);
          return false;
        }
      };
      const pending = queue.current.then(save, save);
      queue.current = pending;
      return pending;
    },
    [publish, fail],
  );

  const schedule = useCallback(() => {
    clearTimer();
    if (!autoSave.current || !provider.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (
        provider.current &&
        stateRef.current.config &&
        stateRef.current.hasUnsavedChanges
      )
        void saveConfig(provider.current, stateRef.current.config);
    }, delay.current);
  }, [clearTimer, saveConfig]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadVersion.current++;
      clearTimer();
      if (statusTimer.current) clearTimeout(statusTimer.current);
      if (
        autoSave.current &&
        provider.current &&
        stateRef.current.hasUnsavedChanges &&
        stateRef.current.config
      )
        void saveConfig(provider.current, stateRef.current.config);
    };
  }, [clearTimer, saveConfig]);

  const loadConfig = useCallback(
    async (id: string) => {
      const version = ++loadVersion.current;
      clearTimer();
      publish({ isLoading: true, loadError: undefined });
      if (
        provider.current &&
        provider.current !== id &&
        stateRef.current.hasUnsavedChanges &&
        stateRef.current.config
      ) {
        if (!(await saveConfig(provider.current, stateRef.current.config)))
          return;
        if (version !== loadVersion.current) return;
        if (stateRef.current.hasUnsavedChanges) {
          publish({ isLoading: false });
          return;
        }
      }
      await queue.current;
      if (version !== loadVersion.current) return;
      try {
        const result = await window.ipc.invoke('config-manager:get', id);
        if (version !== loadVersion.current) return;
        if (result !== null && !validConfig(result))
          throw new Error('Invalid parameter configuration');
        provider.current = id;
        editSession.current++;
        baseline.current = structuredClone(result || emptyConfig());
        publish({
          config: structuredClone(baseline.current),
          providerId: id,
          isLoading: false,
          hasUnsavedChanges: false,
          validationErrors: [],
          lastSaved: result?.lastModified || null,
          saveStatus: 'idle',
          saveMessage: undefined,
        });
      } catch (error) {
        if (version === loadVersion.current) {
          fail(error);
          publish({
            loadError: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    [clearTimer, saveConfig, publish, fail],
  );

  const update = useCallback(
    (change: (config: CustomParameterConfig) => CustomParameterConfig) => {
      if (
        stateRef.current.isLoading ||
        stateRef.current.loadError ||
        !provider.current
      )
        return;
      publish({
        config: change(stateRef.current.config || emptyConfig()),
        hasUnsavedChanges: true,
        validationErrors: [],
        saveStatus: 'idle',
        saveMessage: undefined,
      });
      schedule();
    },
    [publish, schedule],
  );
  const setParameter = useCallback(
    (
      category: 'headerParameters' | 'bodyParameters',
      key: string,
      value: ParameterValue,
    ) => {
      update((config) => ({
        ...config,
        [category]: { ...config[category], [key]: value },
      }));
    },
    [update],
  );
  const removeParameter = useCallback(
    (category: 'headerParameters' | 'bodyParameters', key: string) => {
      update((config) => {
        const values = { ...config[category] };
        delete values[key];
        return { ...config, [category]: values };
      });
    },
    [update],
  );
  const addHeaderParameter = useCallback(
    (key: string, value: ParameterValue) =>
      setParameter('headerParameters', key, value),
    [setParameter],
  );
  const addBodyParameter = useCallback(
    (key: string, value: ParameterValue) =>
      setParameter('bodyParameters', key, value),
    [setParameter],
  );
  const removeHeaderParameter = useCallback(
    (key: string) => removeParameter('headerParameters', key),
    [removeParameter],
  );
  const removeBodyParameter = useCallback(
    (key: string) => removeParameter('bodyParameters', key),
    [removeParameter],
  );

  const resetConfig = useCallback(
    async (id: string) => {
      clearTimer();
      const snapshot = stateRef.current.config;
      const reset = async () => {
        try {
          const result = await window.ipc.invoke('config-manager:delete', id);
          if (result?.success !== true)
            throw new Error(result?.error || 'Failed to reset configuration');
          if (provider.current === id) baseline.current = emptyConfig();
          if (provider.current === id && stateRef.current.config === snapshot)
            publish({
              config: structuredClone(baseline.current),
              hasUnsavedChanges: false,
              isLoading: false,
              validationErrors: [],
              saveStatus: 'idle',
              saveMessage: undefined,
              lastSaved: null,
            });
          else schedule();
          return true;
        } catch (error) {
          if (provider.current === id) fail(error);
          return false;
        }
      };
      const pending = queue.current.then(reset, reset);
      queue.current = pending;
      return pending;
    },
    [clearTimer, publish, schedule, fail],
  );
  const validateConfiguration = useCallback(
    async (
      _id: string,
      config?: CustomParameterConfig,
    ): Promise<ValidationError[]> => {
      const snapshot = config || stateRef.current.config;
      if (!snapshot) return [];
      let errors: ValidationError[];
      try {
        const result = await window.ipc.invoke(
          'config-manager:validate',
          snapshot,
          undefined,
          _id,
        );
        if (!Array.isArray(result?.errors))
          throw new Error('Invalid validation response');
        errors = result.errors;
      } catch {
        errors = [
          {
            key: 'validation',
            type: 'system',
            message: 'Failed to validate configuration',
          },
        ];
      }
      if (!config && stateRef.current.config === snapshot)
        publish({ validationErrors: errors });
      return errors;
    },
    [publish],
  );
  const exportConfiguration = useCallback(
    () =>
      stateRef.current.config
        ? JSON.stringify(
            {
              version: '1.0.0',
              exportedAt: new Date().toISOString(),
              configuration: stateRef.current.config,
            },
            null,
            2,
          )
        : null,
    [],
  );
  const importConfiguration = useCallback(
    (json: string) => {
      try {
        const imported = JSON.parse(json).configuration;
        if (!validConfig(imported)) return false;
        update(() => ({ ...imported, lastModified: Date.now() }));
        return true;
      } catch {
        return false;
      }
    },
    [update],
  );
  const disableAutoSave = useCallback(() => {
    autoSave.current = false;
    clearTimer();
  }, [clearTimer]);
  const enableAutoSave = useCallback(
    (id: string, intervalMs = 2000) => {
      if (provider.current !== id) return;
      autoSave.current = true;
      delay.current = Math.max(0, intervalMs);
      schedule();
    },
    [schedule],
  );
  const getIsDirty = useCallback(() => stateRef.current.hasUnsavedChanges, []);
  const flush = useCallback(async () => {
    clearTimer();
    const current = stateRef.current;
    if (!current.hasUnsavedChanges) return true;
    if (!provider.current || !current.config) return false;
    return (
      (await saveConfig(provider.current, current.config)) &&
      !stateRef.current.hasUnsavedChanges
    );
  }, [clearTimer, saveConfig]);
  const discardChanges = useCallback(() => {
    clearTimer();
    editSession.current++;
    publish({
      config: structuredClone(baseline.current),
      hasUnsavedChanges: false,
      saveStatus: 'idle',
      saveMessage: undefined,
    });
  }, [clearTimer, publish]);
  const request = useCallback(
    async (channel: string, fallback: any, ...args: any[]) => {
      try {
        return (await window.ipc.invoke(channel, ...args)) ?? fallback;
      } catch {
        return fallback;
      }
    },
    [],
  );
  const getSupportedParameters = useCallback(
    (id: string) => request('getSupportedParameters', [], id),
    [request],
  );
  const getParameterDefinition = useCallback(
    (key: string) => request('getParameterDefinition', null, key),
    [request],
  );
  const getMigrationStatus = useCallback(
    (id: string) => request('config-manager:get-migration-status', null, id),
    [request],
  );
  const getAppliedMigrations = useCallback(
    () => request('config-manager:get-applied-migrations', []),
    [request],
  );
  const getAvailableMigrations = useCallback(
    () => request('config-manager:get-available-migrations', []),
    [request],
  );
  return {
    state,
    loadConfig,
    saveConfig,
    resetConfig,
    addHeaderParameter,
    updateHeaderParameter: addHeaderParameter,
    removeHeaderParameter,
    addBodyParameter,
    updateBodyParameter: addBodyParameter,
    removeBodyParameter,
    validateConfiguration,
    exportConfiguration,
    importConfiguration,
    disableAutoSave,
    enableAutoSave,
    getIsDirty,
    flush,
    discardChanges,
    getSupportedParameters,
    getParameterDefinition,
    getMigrationStatus,
    getAppliedMigrations,
    getAvailableMigrations,
  };
}
