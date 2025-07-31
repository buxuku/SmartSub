/**
 * Parameter Validation Service
 *
 * Provides comprehensive validation for custom parameter configurations
 * including type checking, constraint validation, and security checks.
 */

import type {
  CustomParameterConfig,
  ParameterValue,
  ValidationError,
  ParameterValidationResult,
} from '../../types/provider';

export interface ValidationRules {
  maxParameterCount?: number;
  maxKeyLength?: number;
  maxValueLength?: number;
  allowedValueTypes?: Array<
    'string' | 'number' | 'boolean' | 'object' | 'array'
  >;
  reservedKeys?: string[];
  requireHttpsForSecrets?: boolean;
  disallowedPatterns?: RegExp[];
}

export interface ValidationContext {
  providerId: string;
  isProduction?: boolean;
  securityLevel?: 'low' | 'medium' | 'high';
}

export class ParameterValidator {
  private readonly defaultRules: ValidationRules = {
    maxParameterCount: 50,
    maxKeyLength: 128,
    maxValueLength: 2048,
    allowedValueTypes: ['string', 'number', 'boolean', 'object', 'array'],
    reservedKeys: [
      'authorization',
      'content-type',
      'user-agent',
      'accept',
      'accept-encoding',
      'accept-language',
      'connection',
      'host',
      'content-length',
      'transfer-encoding',
      'upgrade',
      'via',
      'warning',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
    ],
    requireHttpsForSecrets: true,
    disallowedPatterns: [
      /password/i,
      /secret/i,
      /token/i,
      /key/i,
      /auth/i,
      /credential/i,
      /private/i,
    ],
  };

  /**
   * Validate a complete parameter configuration
   */
  async validateConfiguration(
    config: CustomParameterConfig,
    context: ValidationContext,
    customRules?: Partial<ValidationRules>,
  ): Promise<ParameterValidationResult> {
    const rules = { ...this.defaultRules, ...customRules };
    const errors: ValidationError[] = [];

    try {
      // Structure validation
      const structureErrors = this.validateStructure(config);
      if (structureErrors && Array.isArray(structureErrors)) {
        errors.push(...structureErrors);
      }

      // Header parameters validation
      if (config.headerParameters) {
        const headerErrors = this.validateParameters(
          config.headerParameters,
          'header',
          rules,
          context,
        );
        if (headerErrors && Array.isArray(headerErrors)) {
          errors.push(...headerErrors);
        }
      }

      // Body parameters validation
      if (config.bodyParameters) {
        const bodyErrors = this.validateParameters(
          config.bodyParameters,
          'body',
          rules,
          context,
        );
        if (bodyErrors && Array.isArray(bodyErrors)) {
          errors.push(...bodyErrors);
        }
      }

      // Cross-parameter validation
      const crossErrors = this.validateCrossParameters(config, rules, context);
      if (crossErrors && Array.isArray(crossErrors)) {
        errors.push(...crossErrors);
      }

      // Security validation
      const securityErrors = this.validateSecurity(config, rules, context);
      if (securityErrors && Array.isArray(securityErrors)) {
        errors.push(...securityErrors);
      }
    } catch (error) {
      errors.push({
        field: 'config',
        message: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        code: 'VALIDATION_ERROR',
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate configuration structure
   */
  private validateStructure(config: CustomParameterConfig): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!config || typeof config !== 'object') {
      errors.push({
        field: 'config',
        message: 'Configuration must be a valid object',
        code: 'INVALID_TYPE',
      });
      return errors;
    }

    // Check for required fields structure
    if (
      config.headerParameters &&
      typeof config.headerParameters !== 'object'
    ) {
      errors.push({
        field: 'headerParameters',
        message: 'Header parameters must be an object',
        code: 'INVALID_TYPE',
      });
    }

    if (config.bodyParameters && typeof config.bodyParameters !== 'object') {
      errors.push({
        field: 'bodyParameters',
        message: 'Body parameters must be an object',
        code: 'INVALID_TYPE',
      });
    }

    // Validate version if present
    if (config.configVersion && typeof config.configVersion !== 'string') {
      errors.push({
        field: 'configVersion',
        message: 'Configuration version must be a string',
        code: 'INVALID_TYPE',
      });
    }

    return errors;
  }

  /**
   * Validate individual parameters
   */
  private validateParameters(
    parameters: Record<string, ParameterValue>,
    parameterType: 'header' | 'body',
    rules: ValidationRules,
    context: ValidationContext,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const parameterCount = Object.keys(parameters).length;

    // Check parameter count limit
    if (rules.maxParameterCount && parameterCount > rules.maxParameterCount) {
      errors.push({
        field: `${parameterType}Parameters`,
        message: `Too many ${parameterType} parameters. Maximum allowed: ${rules.maxParameterCount}`,
        code: 'PARAMETER_COUNT_EXCEEDED',
      });
    }

    for (const [key, value] of Object.entries(parameters)) {
      const keyErrors = this.validateParameterKey(key, parameterType, rules);
      if (keyErrors && Array.isArray(keyErrors)) {
        errors.push(...keyErrors);
      }

      const valueErrors = this.validateParameterValue(
        key,
        value,
        parameterType,
        rules,
        context,
      );
      if (valueErrors && Array.isArray(valueErrors)) {
        errors.push(...valueErrors);
      }
    }

    return errors;
  }

  /**
   * Validate parameter key
   */
  private validateParameterKey(
    key: string,
    parameterType: 'header' | 'body',
    rules: ValidationRules,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    // Check key length
    if (rules.maxKeyLength && key.length > rules.maxKeyLength) {
      errors.push({
        field: key,
        message: `Parameter key too long. Maximum length: ${rules.maxKeyLength}`,
        code: 'KEY_TOO_LONG',
      });
    }

    // Check for empty key
    if (!key || key.trim().length === 0) {
      errors.push({
        field: key,
        message: 'Parameter key cannot be empty',
        code: 'EMPTY_KEY',
      });
    }

    // Check for reserved keys
    if (rules.reservedKeys && rules.reservedKeys.includes(key.toLowerCase())) {
      errors.push({
        field: key,
        message: `Parameter key '${key}' is reserved and cannot be used`,
        code: 'RESERVED_KEY',
      });
    }

    // Check for invalid characters in key
    if (parameterType === 'header' && !/^[a-zA-Z0-9\-_]+$/.test(key)) {
      errors.push({
        field: key,
        message: `Invalid characters in header key '${key}'. Only alphanumeric, hyphens, and underscores are allowed`,
        code: 'INVALID_KEY_CHARACTERS',
      });
    }

    return errors;
  }

  /**
   * Validate parameter value
   */
  private validateParameterValue(
    key: string,
    value: ParameterValue,
    parameterType: 'header' | 'body',
    rules: ValidationRules,
    context: ValidationContext,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (value === null || value === undefined) {
      return errors; // Null/undefined values are allowed
    }

    const valueType = Array.isArray(value) ? 'array' : typeof value;

    // Check allowed value types
    if (
      rules.allowedValueTypes &&
      !rules.allowedValueTypes.includes(valueType as any)
    ) {
      errors.push({
        field: key,
        message: `Invalid value type '${valueType}' for parameter '${key}'. Allowed types: ${rules.allowedValueTypes.join(', ')}`,
        code: 'INVALID_VALUE_TYPE',
      });
    }

    // Check value length for strings
    if (typeof value === 'string') {
      if (rules.maxValueLength && value.length > rules.maxValueLength) {
        errors.push({
          field: key,
          message: `Parameter value too long. Maximum length: ${rules.maxValueLength}`,
          code: 'VALUE_TOO_LONG',
        });
      }

      // Check for potentially sensitive data patterns
      if (rules.disallowedPatterns) {
        for (const pattern of rules.disallowedPatterns) {
          if (pattern.test(key) || pattern.test(value)) {
            errors.push({
              field: key,
              message: `Parameter '${key}' may contain sensitive data. Consider using environment variables or secure storage`,
              code: 'POTENTIAL_SENSITIVE_DATA',
            });
            break;
          }
        }
      }
    }

    // Validate object values
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      try {
        JSON.stringify(value);
      } catch (error) {
        errors.push({
          field: key,
          message: `Parameter '${key}' contains non-serializable object`,
          code: 'NON_SERIALIZABLE_VALUE',
        });
      }
    }

    // Header-specific validation
    if (parameterType === 'header') {
      const headerErrors = this.validateHeaderValue(key, value);
      if (headerErrors && Array.isArray(headerErrors)) {
        errors.push(...headerErrors);
      }
    }

    return errors;
  }

  /**
   * Validate header-specific values
   */
  private validateHeaderValue(
    key: string,
    value: ParameterValue,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    // Headers should typically be strings
    if (typeof value !== 'string' && value !== null && value !== undefined) {
      errors.push({
        field: key,
        message: `Header '${key}' should be a string value`,
        code: 'INVALID_HEADER_VALUE_TYPE',
      });
    }

    // Check for control characters in header values
    if (typeof value === 'string' && /[\x00-\x1F\x7F]/.test(value)) {
      errors.push({
        field: key,
        message: `Header '${key}' contains invalid control characters`,
        code: 'INVALID_HEADER_CHARACTERS',
      });
    }

    return errors;
  }

  /**
   * Cross-parameter validation
   */
  private validateCrossParameters(
    config: CustomParameterConfig,
    rules: ValidationRules,
    context: ValidationContext,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    const allParams = {
      ...config.headerParameters,
      ...config.bodyParameters,
    };

    // Check for duplicate keys between headers and body
    const headerKeys = Object.keys(config.headerParameters || {});
    const bodyKeys = Object.keys(config.bodyParameters || {});
    const duplicates = headerKeys.filter((key) => bodyKeys.includes(key));

    if (duplicates.length > 0) {
      errors.push({
        field: 'parameters',
        message: `Duplicate parameter keys found in headers and body: ${duplicates.join(', ')}`,
        code: 'DUPLICATE_PARAMETER_KEYS',
      });
    }

    // Check for conflicting content-type specifications
    const hasContentTypeHeader = headerKeys.some(
      (key) => key.toLowerCase() === 'content-type',
    );
    const hasBodyParams = bodyKeys.length > 0;

    if (hasContentTypeHeader && hasBodyParams) {
      // This might be intentional, but worth flagging
      errors.push({
        field: 'parameters',
        message:
          'Both Content-Type header and body parameters are specified. Ensure they are compatible',
        code: 'POTENTIAL_CONTENT_TYPE_CONFLICT',
      });
    }

    return errors;
  }

  /**
   * Security-focused validation
   */
  private validateSecurity(
    config: CustomParameterConfig,
    rules: ValidationRules,
    context: ValidationContext,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    const allParams = {
      ...config.headerParameters,
      ...config.bodyParameters,
    };

    // Check for potentially sensitive parameter names or values
    for (const [key, value] of Object.entries(allParams)) {
      if (typeof value === 'string') {
        // Check for hardcoded credentials patterns
        if (this.containsCredentialPattern(key, value)) {
          const severity =
            context.securityLevel === 'high' ? 'error' : 'warning';
          errors.push({
            field: key,
            message: `Parameter '${key}' appears to contain hardcoded credentials. Use environment variables or secure configuration`,
            code: 'HARDCODED_CREDENTIALS',
            severity,
          });
        }

        // Check for URLs with embedded credentials
        if (this.containsUrlWithCredentials(value)) {
          errors.push({
            field: key,
            message: `Parameter '${key}' contains URL with embedded credentials`,
            code: 'URL_WITH_CREDENTIALS',
            severity: 'error',
          });
        }
      }
    }

    // Production-specific checks
    if (context.isProduction) {
      // In production, be more strict about certain patterns
      for (const [key, value] of Object.entries(allParams)) {
        if (
          typeof value === 'string' &&
          (value.includes('localhost') ||
            value.includes('127.0.0.1') ||
            value.includes('development') ||
            value.includes('test'))
        ) {
          errors.push({
            field: key,
            message: `Parameter '${key}' contains development/test values in production environment`,
            code: 'DEV_VALUES_IN_PRODUCTION',
            severity: 'warning',
          });
        }
      }
    }

    return errors;
  }

  /**
   * Check if parameter contains credential patterns
   */
  private containsCredentialPattern(key: string, value: string): boolean {
    const credentialPatterns = [
      /^[A-Za-z0-9+/]{20,}={0,2}$/, // Base64-like patterns
      /^[a-f0-9]{32,}$/i, // Hex patterns (API keys, tokens)
      /^sk-[a-zA-Z0-9]{20,}$/, // OpenAI-style API keys
      /^xoxb-[a-zA-Z0-9-]+$/, // Slack bot tokens
      /^ghp_[a-zA-Z0-9]{36}$/, // GitHub personal access tokens
    ];

    const suspiciousKeyWords = [
      'password',
      'secret',
      'token',
      'key',
      'auth',
      'credential',
      'private',
      'secure',
      'confidential',
    ];

    // Check if key suggests credentials
    const keyLower = key.toLowerCase();
    const hasCredentialKey = suspiciousKeyWords.some((word) =>
      keyLower.includes(word),
    );

    // Check if value matches credential patterns
    const hasCredentialPattern = credentialPatterns.some((pattern) =>
      pattern.test(value),
    );

    return hasCredentialKey && (hasCredentialPattern || value.length > 20);
  }

  /**
   * Check if value contains URL with embedded credentials
   */
  private containsUrlWithCredentials(value: string): boolean {
    const urlWithCredentialsPattern = /https?:\/\/[^:]+:[^@]+@/;
    return urlWithCredentialsPattern.test(value);
  }

  /**
   * Validate a single parameter value with type coercion
   */
  async validateParameterValue(
    key: string,
    value: any,
    expectedType?: string,
    constraints?: any,
  ): Promise<ParameterValidationResult> {
    const errors: ValidationError[] = [];
    let convertedValue = value;

    try {
      // Type validation and coercion
      if (expectedType) {
        switch (expectedType) {
          case 'string':
            convertedValue = String(value);
            break;
          case 'number':
            convertedValue = Number(value);
            if (isNaN(convertedValue)) {
              errors.push({
                field: key,
                message: `Cannot convert '${value}' to number`,
                code: 'TYPE_CONVERSION_ERROR',
              });
            }
            break;
          case 'boolean':
            if (typeof value === 'string') {
              convertedValue = value.toLowerCase() === 'true';
            } else {
              convertedValue = Boolean(value);
            }
            break;
          case 'object':
            if (typeof value === 'string') {
              try {
                convertedValue = JSON.parse(value);
              } catch {
                errors.push({
                  field: key,
                  message: `Invalid JSON string for parameter '${key}'`,
                  code: 'INVALID_JSON',
                });
              }
            }
            break;
        }
      }

      // Constraint validation
      if (constraints && errors.length === 0) {
        errors.push(
          ...this.validateConstraints(key, convertedValue, constraints),
        );
      }
    } catch (error) {
      errors.push({
        field: key,
        message: `Validation error for parameter '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`,
        code: 'VALIDATION_ERROR',
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      convertedValue: errors.length === 0 ? convertedValue : undefined,
    };
  }

  /**
   * Validate constraints
   */
  private validateConstraints(
    key: string,
    value: any,
    constraints: any,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (constraints.min !== undefined && value < constraints.min) {
      errors.push({
        field: key,
        message: `Value ${value} is less than minimum ${constraints.min}`,
        code: 'VALUE_TOO_SMALL',
      });
    }

    if (constraints.max !== undefined && value > constraints.max) {
      errors.push({
        field: key,
        message: `Value ${value} is greater than maximum ${constraints.max}`,
        code: 'VALUE_TOO_LARGE',
      });
    }

    if (constraints.pattern && typeof value === 'string') {
      const pattern = new RegExp(constraints.pattern);
      if (!pattern.test(value)) {
        errors.push({
          field: key,
          message: `Value does not match required pattern`,
          code: 'PATTERN_MISMATCH',
        });
      }
    }

    if (constraints.enum && !constraints.enum.includes(value)) {
      errors.push({
        field: key,
        message: `Value must be one of: ${constraints.enum.join(', ')}`,
        code: 'INVALID_ENUM_VALUE',
      });
    }

    return errors;
  }
}

// Export singleton instance
export const parameterValidator = new ParameterValidator();
