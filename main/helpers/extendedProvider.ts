import { logMessage } from './storeManager';
import { configurationManager } from '../service/configurationManager';
import { ExtendedProvider, CustomParameterConfig } from '../../types/provider';
import { getTaskContext } from './taskContext';
import { resolveCredentials } from './taskRuns/configuration';

/**
 * Load custom parameters for a provider and create an ExtendedProvider
 */
export async function createExtendedProvider(
  baseProvider: any,
): Promise<ExtendedProvider> {
  try {
    // Get custom parameters from configuration manager
    const frozen = getTaskContext()?.resolvedConfig?.providerParameters;
    const current = await configurationManager.getConfiguration(baseProvider.id);
    const providerCustomParams: CustomParameterConfig | null = frozen
      ? resolveCredentials(frozen[baseProvider.id] ?? null, current)
      : current;

    // Create extended provider with custom parameters
    const extendedProvider: ExtendedProvider = {
      ...baseProvider,
      customParameters: providerCustomParams,
    };

    if (providerCustomParams) {
      logMessage(
        `Custom parameters loaded for provider: ${baseProvider.id}`,
        'info',
      );
      logMessage(
        `Header parameters: ${Object.keys(providerCustomParams.headerParameters || {}).length}`,
        'info',
      );
      logMessage(
        `Body parameters: ${Object.keys(providerCustomParams.bodyParameters || {}).length}`,
        'info',
      );
    } else {
      logMessage(
        `No custom parameters found for provider: ${baseProvider.id}`,
        'info',
      );
    }

    return extendedProvider;
  } catch (error) {
    logMessage(
      `Error loading custom parameters for provider ${baseProvider.id}: ${error}`,
      'error',
    );
    // Return base provider if custom parameter loading fails
    return {
      ...baseProvider,
      customParameters: null,
    };
  }
}
