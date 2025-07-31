/**
 * Parameter Processor for Dynamic Parameter System
 *
 * Core engine for parameter validation, merging, and processing.
 * Handles custom parameters with precedence rules and validation.
 */

import {
  ExtendedProvider,
  ProcessedParameters,
  ValidationError,
  ParameterDefinition,
  ParameterValue,
  ValidationRule,
  ParameterValidationResult,
} from '../../types/parameterSystem';

/**
 * Parameter Registry - Known parameters with validation rules
 */
export const PARAMETER_REGISTRY: Record<string, ParameterDefinition> = {
  // Core AI parameters
  temperature: {
    key: 'temperature',
    type: 'number',
    category: 'behavior',
    required: false,
    defaultValue: 0.7,
    validation: { min: 0.0, max: 2.0 },
    description: 'Controls randomness in response generation',
    providerSupport: ['*'],
  },
  max_tokens: {
    key: 'max_tokens',
    type: 'number',
    category: 'response',
    required: false,
    defaultValue: 1000,
    validation: { min: 1, max: 4096 },
    description: 'Maximum number of tokens to generate',
    providerSupport: ['*'],
  },
  top_p: {
    key: 'top_p',
    type: 'number',
    category: 'behavior',
    required: false,
    defaultValue: 1.0,
    validation: { min: 0.0, max: 1.0 },
    description: 'Nucleus sampling parameter',
    providerSupport: ['*'],
  },
  top_k: {
    key: 'top_k',
    type: 'number',
    category: 'behavior',
    required: false,
    defaultValue: 50,
    validation: { min: 1, max: 100 },
    description: 'Top-k sampling parameter',
    providerSupport: ['qwen', 'ollama'],
  },
  stream: {
    key: 'stream',
    type: 'boolean',
    category: 'response',
    required: false,
    defaultValue: false,
    description: 'Enable streaming response',
    providerSupport: ['*'],
  },
  enable_thinking: {
    key: 'enable_thinking',
    type: 'boolean',
    category: 'provider',
    required: false,
    defaultValue: true,
    description: 'Enable/disable thinking mode for supported models',
    providerSupport: ['qwen', 'doubao'],
  },
  thinking: {
    key: 'thinking',
    type: 'string',
    category: 'provider',
    required: false,
    defaultValue: 'enabled',
    validation: { enum: ['enabled', 'disabled', 'auto'] },
    description:
      'Control thinking mode for Volcengine/Doubao (enabled, disabled, auto)',
    providerSupport: ['qwen', 'doubao', 'openai', '*'],
  },
  presence_penalty: {
    key: 'presence_penalty',
    type: 'number',
    category: 'behavior',
    required: false,
    defaultValue: 0.0,
    validation: { min: -2.0, max: 2.0 },
    description: 'Penalty for token presence',
    providerSupport: ['*'],
  },
  frequency_penalty: {
    key: 'frequency_penalty',
    type: 'number',
    category: 'behavior',
    required: false,
    defaultValue: 0.0,
    validation: { min: -2.0, max: 2.0 },
    description: 'Penalty for token frequency',
    providerSupport: ['*'],
  },
};

/**
 * Parameter Processor - Core processing engine
 */
export class ParameterProcessor {
  /**
   * Process custom parameters with validation and merging
   */
  static processCustomParameters(
    provider: ExtendedProvider,
    baseParams: Record<string, any>,
  ): ProcessedParameters {
    const result: ProcessedParameters = {
      headers: {},
      body: { ...baseParams },
      appliedParameters: [],
      skippedParameters: [],
      validationErrors: [],
    };

    if (!provider.customParameters) {
      return result;
    }

    // Process header parameters
    this.processHeaderParameters(
      provider.customParameters.headerParameters || {},
      provider,
      result,
    );

    // Process body parameters with precedence rules
    this.processBodyParameters(
      provider.customParameters.bodyParameters || {},
      provider,
      result,
    );

    // Apply hard-coded parameter logic (highest precedence)
    this.applyHardCodedParameters(provider, result);

    // Validate model compatibility with applied parameters
    this.validateModelCompatibility(provider, result);

    return result;
  }

  /**
   * Process HTTP header parameters
   */
  private static processHeaderParameters(
    headerConfigs: Record<string, ParameterValue>,
    provider: ExtendedProvider,
    result: ProcessedParameters,
  ): void {
    if (!headerConfigs || typeof headerConfigs !== 'object') {
      return;
    }

    Object.entries(headerConfigs).forEach(([key, value]) => {
      const validationResult = this.validateParameter(key, value, provider);

      if (validationResult.isValid) {
        // Substitute template variables (e.g., ${API_KEY})
        const processedValue = this.substituteTemplateVars(
          validationResult.convertedValue,
          provider,
        );
        result.headers[key] = processedValue;
        result.appliedParameters.push(`header:${key}`);
      } else {
        result.validationErrors.push(...validationResult.errors);
        result.skippedParameters.push(`header:${key}`);
      }
    });
  }

  /**
   * Process request body parameters
   */
  private static processBodyParameters(
    bodyConfigs: Record<string, ParameterValue>,
    provider: ExtendedProvider,
    result: ProcessedParameters,
  ): void {
    if (!bodyConfigs || typeof bodyConfigs !== 'object') {
      return;
    }

    Object.entries(bodyConfigs).forEach(([key, value]) => {
      const validationResult = this.validateParameter(key, value, provider);

      if (validationResult.isValid) {
        // Special handling for "thinking" parameter - provider-aware formatting
        if (
          key === 'thinking' &&
          typeof validationResult.convertedValue === 'string'
        ) {
          const thinkingValue = validationResult.convertedValue.toLowerCase();

          // Provider-specific formatting
          if (this.isVolcengineProvider(provider)) {
            // Volcengine format: { "type": "disabled|enabled|auto" }
            result.body.thinking = { type: thinkingValue };
            result.appliedParameters.push(`body:thinking->object`);
            console.log(
              `Applied Volcengine thinking format: { type: "${thinkingValue}" }`,
            );
          } else {
            // Aliyun format: boolean enable_thinking
            const enableThinking =
              thinkingValue === 'enabled' || thinkingValue === 'auto';
            result.body.enable_thinking = enableThinking;
            result.appliedParameters.push(`body:thinking->enable_thinking`);
            console.log(
              `Applied Aliyun thinking format: enable_thinking: ${enableThinking}`,
            );
          }
        } else {
          result.body[key] = validationResult.convertedValue;
          result.appliedParameters.push(`body:${key}`);
        }
      } else {
        result.validationErrors.push(...validationResult.errors);
        result.skippedParameters.push(`body:${key}`);
      }
    });
  }

  /**
   * Apply hard-coded parameters (highest precedence for backward compatibility)
   * Updated to respect user settings while providing sensible defaults
   */
  private static applyHardCodedParameters(
    provider: ExtendedProvider,
    result: ProcessedParameters,
  ): void {
    // Apply default thinking mode for Qwen/Bailian providers ONLY if user hasn't specified a preference
    if (
      provider.id === 'qwen' ||
      provider.apiUrl?.includes('dashscope.aliyuncs.com')
    ) {
      // Only set default if user hasn't specified enable_thinking in custom parameters
      if (!result.body.hasOwnProperty('enable_thinking')) {
        result.body.enable_thinking = false; // Default to false for performance
        result.appliedParameters.push('default:enable_thinking');
        console.log(
          'Applied default enable_thinking: false (no user preference specified)',
        );
      } else {
        console.log(
          `Respecting user preference for enable_thinking: ${result.body.enable_thinking}`,
        );
      }
    }

    // Add other hard-coded logic as needed for backward compatibility
  }

  /**
   * Validate a single parameter
   */
  static validateParameter(
    key: string,
    value: ParameterValue,
    provider: ExtendedProvider,
  ): ParameterValidationResult {
    const definition = PARAMETER_REGISTRY[key];
    const errors: ValidationError[] = [];

    // If parameter is not in registry, allow it (for extensibility)
    if (!definition) {
      return { isValid: true, errors: [], convertedValue: value };
    }

    // Provider compatibility check
    if (
      definition.providerSupport &&
      !definition.providerSupport.includes('*') &&
      !definition.providerSupport.includes(provider.id || '')
    ) {
      errors.push({
        key,
        type: 'dependency',
        message: `Parameter '${key}' is not supported by provider '${provider.id}'`,
        suggestion: `This parameter is only supported by: ${definition.providerSupport.join(', ')}`,
      });
      return { isValid: false, errors };
    }

    // Type validation and conversion
    const typeValidation = this.validateType(value, definition.type);
    if (!typeValidation.isValid) {
      errors.push(...typeValidation.errors);
      return { isValid: false, errors };
    }

    // Range validation
    if (definition.validation) {
      const rangeValidation = this.validateRange(
        typeValidation.convertedValue,
        definition.validation,
      );
      if (!rangeValidation.isValid) {
        errors.push(...rangeValidation.errors);
        return { isValid: false, errors };
      }
    }

    return {
      isValid: true,
      errors: [],
      convertedValue: typeValidation.convertedValue,
    };
  }

  /**
   * Validate model compatibility with applied parameters
   * Prevents API errors by checking for known incompatible combinations
   */
  private static validateModelCompatibility(
    provider: ExtendedProvider,
    result: ProcessedParameters,
  ): void {
    // Check for thinking-only models that cannot disable thinking mode
    if (this.isThinkingOnlyModel(provider)) {
      const enableThinking = result.body.enable_thinking;

      if (enableThinking === false) {
        // Remove the incompatible parameter and add a warning
        delete result.body.enable_thinking;

        const error: ValidationError = {
          key: 'enable_thinking',
          type: 'dependency',
          message: `Model '${provider.modelName}' is a thinking-only model that cannot disable thinking mode`,
          suggestion:
            'Use a standard model (e.g., qwen3-235b-a22b) to control thinking mode, or remove the enable_thinking parameter',
        };

        result.validationErrors.push(error);
        result.skippedParameters.push('body:enable_thinking');

        console.warn(`Model compatibility warning: ${error.message}`);
        console.log(`Suggestion: ${error.suggestion}`);
      }
    }
  }

  /**
   * Detect if a model is a thinking-only model that cannot disable thinking mode
   */
  private static isThinkingOnlyModel(provider: ExtendedProvider): boolean {
    const modelName = provider.modelName?.toLowerCase() || '';

    // Known thinking-only model patterns for Ali-Bailian
    const thinkingOnlyPatterns = [
      'thinking-2507', // qwen3-235b-a22b-thinking-2507
      'thinking-', // Any model with "thinking-" in the name
      '-reasoning', // Models with reasoning suffix
    ];

    return thinkingOnlyPatterns.some((pattern) => modelName.includes(pattern));
  }

  /**
   * Detect if provider is Volcengine/Doubao type requiring object format for thinking parameter
   */
  private static isVolcengineProvider(provider: ExtendedProvider): boolean {
    return (
      provider.type === 'doubao' ||
      provider.apiUrl?.includes('volces.com') ||
      provider.apiUrl?.includes('volcengine')
    );
  }

  /**
   * Validate parameter type and convert if necessary
   */
  private static validateType(
    value: ParameterValue,
    expectedType: string,
  ): ParameterValidationResult {
    const errors: ValidationError[] = [];

    switch (expectedType) {
      case 'string':
        if (typeof value !== 'string') {
          // Try to convert to string
          try {
            const converted = String(value);
            return { isValid: true, errors: [], convertedValue: converted };
          } catch (error) {
            errors.push({
              key: 'type',
              type: 'type',
              message: `Expected string, got ${typeof value}`,
              suggestion: 'Provide a valid string value',
            });
            return { isValid: false, errors };
          }
        }
        break;

      case 'integer':
        if (typeof value !== 'number') {
          // Try to convert to integer
          const converted = parseInt(String(value), 10);
          if (isNaN(converted)) {
            errors.push({
              key: 'type',
              type: 'type',
              message: `Expected integer, got ${typeof value}`,
              suggestion: 'Provide a valid integer value',
            });
            return { isValid: false, errors };
          }
          return { isValid: true, errors: [], convertedValue: converted };
        } else {
          // Ensure integer value
          return {
            isValid: true,
            errors: [],
            convertedValue: Math.floor(value),
          };
        }
        break;

      case 'float':
        if (typeof value !== 'number') {
          // Try to convert to float
          const converted = parseFloat(String(value));
          if (isNaN(converted)) {
            errors.push({
              key: 'type',
              type: 'type',
              message: `Expected float, got ${typeof value}`,
              suggestion: 'Provide a valid floating point value',
            });
            return { isValid: false, errors };
          }
          return { isValid: true, errors: [], convertedValue: converted };
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          // Try to convert to boolean
          if (value === 'true') {
            return { isValid: true, errors: [], convertedValue: true };
          } else if (value === 'false') {
            return { isValid: true, errors: [], convertedValue: false };
          } else {
            errors.push({
              key: 'type',
              type: 'type',
              message: `Expected boolean, got ${typeof value}`,
              suggestion: 'Use true or false',
            });
            return { isValid: false, errors };
          }
        }
        break;

      case 'object':
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value)
        ) {
          errors.push({
            key: 'type',
            type: 'type',
            message: `Expected object, got ${typeof value}`,
            suggestion: 'Provide a valid JSON object',
          });
          return { isValid: false, errors };
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          errors.push({
            key: 'type',
            type: 'type',
            message: `Expected array, got ${typeof value}`,
            suggestion: 'Provide a valid array',
          });
          return { isValid: false, errors };
        }
        break;

      default:
        errors.push({
          key: 'type',
          type: 'type',
          message: `Unknown parameter type: ${expectedType}`,
          suggestion:
            'Use one of: string, integer, float, boolean, object, array',
        });
        return { isValid: false, errors };
    }

    return { isValid: true, errors: [], convertedValue: value };
  }

  /**
   * Validate parameter range and constraints
   */
  private static validateRange(
    value: any,
    validation: ValidationRule,
  ): ParameterValidationResult {
    const errors: ValidationError[] = [];

    // Min/max validation for numbers
    if (typeof value === 'number') {
      if (validation.min !== undefined && value < validation.min) {
        errors.push({
          key: 'range',
          type: 'range',
          message: `Value ${value} is below minimum ${validation.min}`,
          suggestion: `Use a value >= ${validation.min}`,
        });
      }
      if (validation.max !== undefined && value > validation.max) {
        errors.push({
          key: 'range',
          type: 'range',
          message: `Value ${value} is above maximum ${validation.max}`,
          suggestion: `Use a value <= ${validation.max}`,
        });
      }
    }

    // Enum validation
    if (validation.enum && !validation.enum.includes(value)) {
      errors.push({
        key: 'enum',
        type: 'format',
        message: `Value '${value}' is not allowed`,
        suggestion: `Use one of: ${validation.enum.join(', ')}`,
      });
    }

    // Pattern validation for strings
    if (typeof value === 'string' && validation.pattern) {
      const regex = new RegExp(validation.pattern);
      if (!regex.test(value)) {
        errors.push({
          key: 'pattern',
          type: 'format',
          message: `Value '${value}' does not match required pattern`,
          suggestion: `Use a value matching pattern: ${validation.pattern}`,
        });
      }
    }

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Substitute template variables in parameter values
   */
  private static substituteTemplateVars(
    value: any,
    provider: ExtendedProvider,
  ): any {
    if (typeof value !== 'string') {
      return value;
    }

    let result = value;

    // Replace common template variables
    result = result.replace(/\$\{API_KEY\}/g, provider.apiKey || '');
    result = result.replace(/\$\{BASE_URL\}/g, provider.apiUrl || '');
    result = result.replace(/\$\{MODEL_NAME\}/g, provider.modelName || '');

    return result;
  }

  /**
   * Merge parameters with precedence rules
   */
  static mergeParameters(
    hardCoded: Record<string, any>,
    custom: Record<string, any>,
  ): Record<string, any> {
    // Hard-coded parameters take precedence over custom parameters
    return { ...custom, ...hardCoded };
  }

  /**
   * Get parameter definition from registry
   */
  static getParameterDefinition(key: string): ParameterDefinition | null {
    return PARAMETER_REGISTRY[key] || null;
  }

  /**
   * Get all supported parameters for a provider
   */
  static getSupportedParameters(providerId: string): ParameterDefinition[] {
    return Object.values(PARAMETER_REGISTRY).filter(
      (param) =>
        param.providerSupport.includes('*') ||
        param.providerSupport.includes(providerId),
    );
  }

  /**
   * Validate entire parameter configuration
   */
  static validateParameterConfiguration(
    provider: ExtendedProvider,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!provider.customParameters) {
      return errors;
    }

    // Validate header parameters
    Object.entries(provider.customParameters.headerConfigs).forEach(
      ([key, value]) => {
        const result = this.validateParameter(key, value, provider);
        if (!result.isValid) {
          errors.push(...result.errors);
        }
      },
    );

    // Validate body parameters
    Object.entries(provider.customParameters.bodyConfigs).forEach(
      ([key, value]) => {
        const result = this.validateParameter(key, value, provider);
        if (!result.isValid) {
          errors.push(...result.errors);
        }
      },
    );

    return errors;
  }
}
