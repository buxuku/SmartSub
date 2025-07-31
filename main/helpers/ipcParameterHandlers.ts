/**
 * IPC Handlers for Parameter Management
 *
 * Handles communication between renderer and main process for
 * custom parameter configuration management.
 */

import { ipcMain } from 'electron';
import { store } from './store';
import { ParameterProcessor } from './parameterProcessor';
import { configurationManager } from '../service/configurationManager';
import {
  ExtendedProvider,
  CustomParameterConfig,
  ValidationError,
} from '../../types/provider';
import {
  IpcParameterMessage,
  IpcParameterResponse,
} from '../../types/parameterSystem';
import { logMessage } from './storeManager';

/**
 * Get custom parameters for a specific provider
 */
async function getCustomParameters(
  providerId: string,
): Promise<CustomParameterConfig | null> {
  try {
    return await configurationManager.getConfiguration(providerId);
  } catch (error) {
    logMessage(
      `Error getting custom parameters for ${providerId}: ${error}`,
      'error',
    );
    return null;
  }
}

/**
 * Set custom parameters for a specific provider
 */
async function setCustomParameters(
  providerId: string,
  config: CustomParameterConfig,
): Promise<boolean> {
  try {
    await configurationManager.saveConfiguration(providerId, {
      ...config,
      lastModified: Date.now(),
    });

    logMessage(`Custom parameters updated for provider: ${providerId}`, 'info');
    return true;
  } catch (error) {
    logMessage(
      `Error setting custom parameters for ${providerId}: ${error}`,
      'error',
    );
    return false;
  }
}

/**
 * Delete custom parameters for a specific provider
 */
async function deleteCustomParameters(providerId: string): Promise<boolean> {
  try {
    const result = await configurationManager.deleteConfiguration(providerId);

    logMessage(`Custom parameters deleted for provider: ${providerId}`, 'info');
    return result;
  } catch (error) {
    logMessage(
      `Error deleting custom parameters for ${providerId}: ${error}`,
      'error',
    );
    return false;
  }
}

/**
 * Reset all custom parameters
 */
async function resetAllParameters(): Promise<boolean> {
  try {
    store.set('customParameters', {});
    logMessage('All custom parameters reset', 'info');
    return true;
  } catch (error) {
    logMessage(`Error resetting custom parameters: ${error}`, 'error');
    return false;
  }
}

/**
 * Validate parameter configuration for a provider
 */
async function validateParameterConfiguration(
  providerId: string,
  config: CustomParameterConfig,
): Promise<ValidationError[]> {
  try {
    const result = await configurationManager.validateConfiguration(
      config,
      {},
      providerId,
    );

    // Convert validation result to ValidationError format
    return result.errors.map((error) => ({
      key: error.field || 'unknown',
      type: 'validation' as const,
      message: error.message,
      suggestion: 'Check the parameter configuration and try again',
    }));
  } catch (error) {
    logMessage(
      `Error validating parameters for ${providerId}: ${error}`,
      'error',
    );
    return [
      {
        key: 'validation',
        type: 'system',
        message: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        suggestion: 'Check the parameter configuration and try again',
      },
    ];
  }
}

/**
 * Get supported parameters for a provider
 */
async function getSupportedParameters(providerId: string) {
  try {
    return ParameterProcessor.getSupportedParameters(providerId);
  } catch (error) {
    logMessage(
      `Error getting supported parameters for ${providerId}: ${error}`,
      'error',
    );
    return [];
  }
}

/**
 * Setup IPC handlers for parameter management
 */
export function setupParameterHandlers() {
  // Get custom parameters for a provider
  ipcMain.handle('getCustomParameters', async (event, providerId: string) => {
    return await getCustomParameters(providerId);
  });

  // Set custom parameters for a provider
  ipcMain.handle(
    'setCustomParameters',
    async (event, providerId: string, config: CustomParameterConfig) => {
      return await setCustomParameters(providerId, config);
    },
  );

  // Delete custom parameters for a provider
  ipcMain.handle(
    'deleteCustomParameters',
    async (event, providerId: string) => {
      return await deleteCustomParameters(providerId);
    },
  );

  // Reset all custom parameters
  ipcMain.handle('resetAllParameters', async () => {
    return await resetAllParameters();
  });

  // Validate parameter configuration
  ipcMain.handle(
    'validateParameterConfiguration',
    async (event, providerId: string, config: CustomParameterConfig) => {
      return await validateParameterConfiguration(providerId, config);
    },
  );

  // Get supported parameters for a provider
  ipcMain.handle(
    'getSupportedParameters',
    async (event, providerId: string) => {
      return await getSupportedParameters(providerId);
    },
  );

  // Get parameter definition
  ipcMain.handle(
    'getParameterDefinition',
    async (event, parameterKey: string) => {
      return ParameterProcessor.getParameterDefinition(parameterKey);
    },
  );

  // Handle generic parameter messages
  ipcMain.handle(
    'parameterMessage',
    async (
      event,
      message: IpcParameterMessage,
    ): Promise<IpcParameterResponse> => {
      try {
        switch (message.action) {
          case 'get':
            const config = await getCustomParameters(message.providerId);
            return { success: true, data: config };

          case 'set':
            const setResult = await setCustomParameters(
              message.providerId,
              message.data,
            );
            return { success: setResult };

          case 'delete':
            const deleteResult = await deleteCustomParameters(
              message.providerId,
            );
            return { success: deleteResult };

          case 'reset':
            const resetResult = await resetAllParameters();
            return { success: resetResult };

          case 'validate':
            const errors = await validateParameterConfiguration(
              message.providerId,
              message.data,
            );
            return { success: errors.length === 0, data: errors };

          default:
            return { success: false, error: 'Unknown action' };
        }
      } catch (error) {
        logMessage(`Parameter message handling error: ${error}`, 'error');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  logMessage('Parameter management IPC handlers registered', 'info');
}
