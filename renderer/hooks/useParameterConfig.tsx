/**
 * useParameterConfig Hook
 *
 * React hook for managing custom parameter configurations.
 * Provides CRUD operations, real-time validation, and IPC communication.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CustomParameterConfig,
  ParameterValue,
  ValidationError,
  ParameterDefinition,
} from '../../types/provider';
import {
  ParameterApplyResult,
  IpcParameterMessage,
  IpcParameterResponse,
} from '../../types/parameterSystem';

export interface ParameterConfigState {
  config: CustomParameterConfig | null;
  isLoading: boolean;
  hasUnsavedChanges: boolean;
  validationErrors: ValidationError[];
  lastSaved: number | null;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveMessage?: string;
}

export interface UseParameterConfigReturn {
  // State
  state: ParameterConfigState;

  // Configuration operations
  loadConfig: (providerId: string) => Promise<void>;
  saveConfig: (
    providerId: string,
    config: CustomParameterConfig,
  ) => Promise<boolean>;
  resetConfig: (providerId: string) => Promise<boolean>;

  // Parameter operations
  addHeaderParameter: (key: string, value: ParameterValue) => void;
  updateHeaderParameter: (key: string, value: ParameterValue) => void;
  removeHeaderParameter: (key: string) => void;

  addBodyParameter: (key: string, value: ParameterValue) => void;
  updateBodyParameter: (key: string, value: ParameterValue) => void;
  removeBodyParameter: (key: string) => void;

  // Template operations removed as requested

  // Validation
  validateConfiguration: (
    providerId: string,
    config?: CustomParameterConfig,
  ) => Promise<ValidationError[]>;

  // Utility
  getSupportedParameters: (
    providerId: string,
  ) => Promise<ParameterDefinition[]>;
  getParameterDefinition: (
    parameterKey: string,
  ) => Promise<ParameterDefinition | null>;

  // Export/Import
  exportConfiguration: () => string | null;
  importConfiguration: (jsonString: string) => boolean;

  // Auto-save control
  enableAutoSave: (providerId: string, intervalMs?: number) => void;
  disableAutoSave: () => void;

  // Migration management
  getMigrationStatus: (providerId: string) => Promise<any>;
  getAppliedMigrations: () => Promise<any[]>;
  getAvailableMigrations: () => Promise<any[]>;
}

export function useParameterConfig(): UseParameterConfigReturn {
  // State management
  const [state, setState] = useState<ParameterConfigState>({
    config: null,
    isLoading: false,
    hasUnsavedChanges: false,
    validationErrors: [],
    lastSaved: null,
    saveStatus: 'idle',
  });

  // Refs for tracking changes and auto-save
  const configRef = useRef<CustomParameterConfig | null>(null);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentProviderRef = useRef<string | null>(null);
  const isAutoSaveEnabledRef = useRef<boolean>(true);

  // Update config ref when state changes
  useEffect(() => {
    configRef.current = state.config;
  }, [state.config]);

  // Auto-save functionality
  const triggerAutoSave = useCallback(
    async (config: CustomParameterConfig, providerId: string) => {
      console.log(
        '🔄 [AUTO-SAVE] Triggered for provider:',
        providerId,
        'Config:',
        JSON.stringify(config, null, 2),
      );

      if (!isAutoSaveEnabledRef.current) {
        console.log('❌ [AUTO-SAVE] Auto-save disabled, skipping');
        return;
      }

      if (!providerId) {
        console.log('❌ [AUTO-SAVE] No providerId provided, skipping');
        return;
      }

      // Clear any existing timeout
      if (autoSaveTimeoutRef.current) {
        console.log('🔄 [AUTO-SAVE] Clearing existing timeout');
        clearTimeout(autoSaveTimeoutRef.current);
      }

      // Set new timeout for debounced save
      autoSaveTimeoutRef.current = setTimeout(async () => {
        try {
          console.log('💾 [AUTO-SAVE] Starting save operation...');
          setState((prev) => ({ ...prev, saveStatus: 'saving' }));

          // Check if IPC is available
          if (!window?.ipc) {
            console.error('❌ [AUTO-SAVE] IPC not available');
            setState((prev) => ({
              ...prev,
              saveStatus: 'error',
              saveMessage: 'IPC not available',
            }));
            return;
          }

          console.log('📡 [AUTO-SAVE] Calling IPC config-manager:save with:', {
            providerId,
            config,
          });
          const result = await window.ipc.invoke(
            'config-manager:save',
            providerId,
            config,
          );
          console.log('📡 [AUTO-SAVE] IPC response:', result);

          const success = result?.success;

          if (success) {
            console.log('✅ [AUTO-SAVE] Save successful');
            setState((prev) => ({
              ...prev,
              hasUnsavedChanges: false,
              lastSaved: Date.now(),
              saveStatus: 'saved',
              saveMessage: 'Changes saved automatically',
            }));

            // Clear "saved" status after 3 seconds
            setTimeout(() => {
              setState((prev) => ({
                ...prev,
                saveStatus: 'idle',
                saveMessage: undefined,
              }));
            }, 3000);
          } else {
            console.error('❌ [AUTO-SAVE] Save failed - success=false');
            setState((prev) => ({
              ...prev,
              saveStatus: 'error',
              saveMessage: 'Failed to save changes',
            }));

            // Clear error status after 5 seconds to avoid persistent error state
            setTimeout(() => {
              setState((prev) => ({
                ...prev,
                saveStatus: 'idle',
                saveMessage: undefined,
              }));
            }, 5000);
          }
        } catch (error) {
          console.error('❌ [AUTO-SAVE] Exception during save:', error);
          setState((prev) => ({
            ...prev,
            saveStatus: 'error',
            saveMessage: `Auto-save failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }));

          // Clear error status after 5 seconds to avoid persistent error state
          setTimeout(() => {
            setState((prev) => ({
              ...prev,
              saveStatus: 'idle',
              saveMessage: undefined,
            }));
          }, 5000);
        }
      }, 2000); // 2-second delay
    },
    [],
  );

  // Cleanup auto-save on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, []);

  // Load configuration for a provider
  const loadConfig = useCallback(async (providerId: string) => {
    console.log('📥 [CONFIG-LOAD] Loading config for provider:', providerId);
    setState((prev) => ({ ...prev, isLoading: true }));

    try {
      if (!window?.ipc) {
        console.error('❌ [CONFIG-LOAD] IPC not available');
        throw new Error('IPC not available');
      }

      console.log(
        '📡 [CONFIG-LOAD] Calling IPC config-manager:get with:',
        providerId,
      );
      const config = await window.ipc.invoke('config-manager:get', providerId);
      console.log('📡 [CONFIG-LOAD] IPC response:', config);

      setState((prev) => ({
        ...prev,
        config,
        isLoading: false,
        hasUnsavedChanges: false,
        validationErrors: [],
        lastSaved: config?.lastModified || null,
        saveStatus: 'idle',
      }));

      currentProviderRef.current = providerId;
      console.log(
        '✅ [CONFIG-LOAD] Config loaded successfully, provider set to:',
        providerId,
      );
    } catch (error) {
      console.error('❌ [CONFIG-LOAD] Failed to load parameter config:', error);
      setState((prev) => ({
        ...prev,
        isLoading: false,
        validationErrors: [
          {
            key: 'load',
            type: 'system',
            message: 'Failed to load configuration',
            suggestion: 'Please try again or check your connection',
          },
        ],
      }));
    }
  }, []);

  // Save configuration
  const saveConfig = useCallback(
    async (providerId: string, config: CustomParameterConfig) => {
      setState((prev) => ({ ...prev, isLoading: true }));

      try {
        const result = await window?.ipc?.invoke(
          'config-manager:save',
          providerId,
          config,
        );
        const success = result?.success;

        if (success) {
          setState((prev) => ({
            ...prev,
            config: { ...config, lastModified: Date.now() },
            isLoading: false,
            hasUnsavedChanges: false,
            lastSaved: Date.now(),
          }));
          return true;
        } else {
          setState((prev) => ({
            ...prev,
            isLoading: false,
            validationErrors: [
              {
                key: 'save',
                type: 'system',
                message: 'Failed to save configuration',
                suggestion: 'Please try again or check your permissions',
              },
            ],
          }));
          return false;
        }
      } catch (error) {
        console.error('Failed to save parameter config:', error);
        setState((prev) => ({
          ...prev,
          isLoading: false,
          validationErrors: [
            {
              key: 'save',
              type: 'system',
              message: 'Failed to save configuration',
              suggestion: 'Please try again or check your connection',
            },
          ],
        }));
        return false;
      }
    },
    [],
  );

  // Reset configuration
  const resetConfig = useCallback(async (providerId: string) => {
    setState((prev) => ({ ...prev, isLoading: true }));

    try {
      const result = await window?.ipc?.invoke(
        'config-manager:delete',
        providerId,
      );
      const success = result?.success;

      if (success) {
        setState((prev) => ({
          ...prev,
          config: null,
          isLoading: false,
          hasUnsavedChanges: false,
          validationErrors: [],
          lastSaved: null,
        }));
        return true;
      } else {
        setState((prev) => ({ ...prev, isLoading: false }));
        return false;
      }
    } catch (error) {
      console.error('Failed to reset parameter config:', error);
      setState((prev) => ({ ...prev, isLoading: false }));
      return false;
    }
  }, []);

  // Helper function to update config and mark as changed
  const updateConfig = useCallback(
    (updater: (config: CustomParameterConfig) => CustomParameterConfig) => {
      console.log('🔧 [UPDATE-CONFIG] Starting config update...');

      setState((prev) => {
        const currentConfig = prev.config || {
          headerParameters: {},
          bodyParameters: {},
          configVersion: '1.0.0',
          lastModified: Date.now(),
        };

        console.log('🔧 [UPDATE-CONFIG] Current config:', currentConfig);
        const newConfig = updater(currentConfig);
        console.log('🔧 [UPDATE-CONFIG] New config:', newConfig);

        // Trigger auto-save if provider is available
        const providerId = currentProviderRef.current;
        console.log('🔧 [UPDATE-CONFIG] Provider ID from ref:', providerId);

        if (providerId) {
          console.log('🔧 [UPDATE-CONFIG] Triggering auto-save...');
          triggerAutoSave(newConfig, providerId);
        } else {
          console.warn(
            '⚠️ [UPDATE-CONFIG] No provider ID available, skipping auto-save',
          );
        }

        return {
          ...prev,
          config: newConfig,
          hasUnsavedChanges: true,
          validationErrors: [], // Clear validation errors when config is updated
        };
      });
    },
    [triggerAutoSave],
  );

  // Header parameter operations
  const addHeaderParameter = useCallback(
    (key: string, value: ParameterValue) => {
      updateConfig((config) => ({
        ...config,
        headerParameters: {
          ...config.headerParameters,
          [key]: value,
        },
      }));
    },
    [updateConfig],
  );

  const updateHeaderParameter = useCallback(
    (key: string, value: ParameterValue) => {
      updateConfig((config) => ({
        ...config,
        headerParameters: {
          ...config.headerParameters,
          [key]: value,
        },
      }));
    },
    [updateConfig],
  );

  const removeHeaderParameter = useCallback(
    (key: string) => {
      updateConfig((config) => {
        const { [key]: removed, ...rest } = config.headerParameters;
        return {
          ...config,
          headerParameters: rest,
        };
      });
    },
    [updateConfig],
  );

  // Body parameter operations
  const addBodyParameter = useCallback(
    (key: string, value: ParameterValue) => {
      updateConfig((config) => ({
        ...config,
        bodyParameters: {
          ...config.bodyParameters,
          [key]: value,
        },
      }));
    },
    [updateConfig],
  );

  const updateBodyParameter = useCallback(
    (key: string, value: ParameterValue) => {
      updateConfig((config) => ({
        ...config,
        bodyParameters: {
          ...config.bodyParameters,
          [key]: value,
        },
      }));
    },
    [updateConfig],
  );

  const removeBodyParameter = useCallback(
    (key: string) => {
      updateConfig((config) => {
        const { [key]: removed, ...rest } = config.bodyParameters;
        return {
          ...config,
          bodyParameters: rest,
        };
      });
    },
    [updateConfig],
  );

  // Template operations removed as requested

  // Validation
  const validateConfiguration = useCallback(
    async (
      providerId: string,
      config?: CustomParameterConfig,
    ): Promise<ValidationError[]> => {
      const configToValidate = config || state.config;

      if (!configToValidate) {
        return [];
      }

      try {
        const validation = await window?.ipc?.invoke(
          'config-manager:validate',
          configToValidate,
        );
        const errors = validation?.errors || [];

        // Update state with validation errors if validating current config
        if (!config) {
          setState((prev) => ({ ...prev, validationErrors: errors }));
        }

        return errors;
      } catch (error) {
        console.error('Failed to validate configuration:', error);
        const systemError = [
          {
            key: 'validation',
            type: 'system' as const,
            message: 'Failed to validate configuration',
            suggestion: 'Please try again or check your connection',
          },
        ];

        if (!config) {
          setState((prev) => ({ ...prev, validationErrors: systemError }));
        }

        return systemError;
      }
    },
    [state.config],
  );

  // Utility functions
  const getSupportedParameters = useCallback(
    async (providerId: string): Promise<ParameterDefinition[]> => {
      try {
        return (
          (await window?.ipc?.invoke('getSupportedParameters', providerId)) ||
          []
        );
      } catch (error) {
        console.error('Failed to get supported parameters:', error);
        return [];
      }
    },
    [],
  );

  const getParameterDefinition = useCallback(
    async (parameterKey: string): Promise<ParameterDefinition | null> => {
      try {
        return await window?.ipc?.invoke(
          'getParameterDefinition',
          parameterKey,
        );
      } catch (error) {
        console.error('Failed to get parameter definition:', error);
        return null;
      }
    },
    [],
  );

  // Export/Import operations
  const exportConfiguration = useCallback((): string | null => {
    if (!state.config) {
      return null;
    }

    try {
      const exportData = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        configuration: state.config,
      };

      return JSON.stringify(exportData, null, 2);
    } catch (error) {
      console.error('Failed to export configuration:', error);
      return null;
    }
  }, [state.config]);

  const importConfiguration = useCallback(
    (jsonString: string): boolean => {
      try {
        const importData = JSON.parse(jsonString);

        if (!importData.configuration) {
          return false;
        }

        const config: CustomParameterConfig = {
          ...importData.configuration,
          lastModified: Date.now(),
        };

        setState((prev) => ({
          ...prev,
          config,
          hasUnsavedChanges: true,
          validationErrors: [],
        }));

        // Trigger auto-save after import if provider is available
        const providerId = currentProviderRef.current;
        if (providerId) {
          console.log(
            '📥 [IMPORT] Triggering auto-save after import for provider:',
            providerId,
          );
          triggerAutoSave(config, providerId);
        } else {
          console.warn(
            '⚠️ [IMPORT] No provider ID available, skipping auto-save after import',
          );
        }

        return true;
      } catch (error) {
        console.error('Failed to import configuration:', error);
        return false;
      }
    },
    [triggerAutoSave],
  );

  // Auto-save functionality
  const enableAutoSave = useCallback(
    (providerId: string, intervalMs: number = 30000) => {
      disableAutoSave(); // Clear any existing interval

      autoSaveTimeoutRef.current = setInterval(async () => {
        if (state.hasUnsavedChanges && configRef.current) {
          await saveConfig(providerId, configRef.current);
        }
      }, intervalMs);
    },
    [state.hasUnsavedChanges, saveConfig],
  );

  const disableAutoSave = useCallback(() => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
      autoSaveTimeoutRef.current = null;
    }
  }, []);

  // Migration management functions
  const getMigrationStatus = useCallback(async (providerId: string) => {
    try {
      return await window?.ipc?.invoke(
        'config-manager:get-migration-status',
        providerId,
      );
    } catch (error) {
      console.error('Failed to get migration status:', error);
      return null;
    }
  }, []);

  const getAppliedMigrations = useCallback(async () => {
    try {
      return (
        (await window?.ipc?.invoke('config-manager:get-applied-migrations')) ||
        []
      );
    } catch (error) {
      console.error('Failed to get applied migrations:', error);
      return [];
    }
  }, []);

  const getAvailableMigrations = useCallback(async () => {
    try {
      return (
        (await window?.ipc?.invoke(
          'config-manager:get-available-migrations',
        )) || []
      );
    } catch (error) {
      console.error('Failed to get available migrations:', error);
      return [];
    }
  }, []);

  return {
    state,
    loadConfig,
    saveConfig,
    resetConfig,
    addHeaderParameter,
    updateHeaderParameter,
    removeHeaderParameter,
    addBodyParameter,
    updateBodyParameter,
    removeBodyParameter,
    validateConfiguration,
    getSupportedParameters,
    getParameterDefinition,
    exportConfiguration,
    importConfiguration,
    enableAutoSave,
    disableAutoSave,
    getMigrationStatus,
    getAppliedMigrations,
    getAvailableMigrations,
  };
}
