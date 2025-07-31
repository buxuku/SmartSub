/**
 * Parameter System Types for Dynamic Parameter Management
 *
 * This file contains shared types for the dynamic parameter system that allows
 * users to configure custom AI model parameters without code modification.
 */

import type {
  ParameterDefinition,
  ValidationError,
  ParameterValue,
  CustomParameterConfig,
  ExtendedProvider,
  ValidationRule,
  ParameterCategory,
  ProcessedParameters,
} from './provider';

// Re-export parameter-specific types for easy importing
export type {
  ParameterValue,
  CustomParameterConfig,
  ExtendedProvider,
  ParameterDefinition,
  ValidationRule,
  ParameterCategory,
  ProcessedParameters,
  ValidationError,
} from './provider';

// Additional parameter system specific types

export interface ParameterRegistry {
  [key: string]: ParameterDefinition;
}

export interface ParameterValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  convertedValue?: any;
}

export interface ParameterManagerConfig {
  enableValidation: boolean;
  maxParametersPerProvider: number;
  allowedParameterTypes: Array<
    'string' | 'number' | 'boolean' | 'object' | 'array'
  >;
}

export interface ParameterApplyResult {
  success: boolean;
  appliedCount: number;
  skippedCount: number;
  errors: ValidationError[];
}

// IPC Message types for parameter management
export interface IpcParameterMessage {
  action: 'get' | 'set' | 'delete' | 'reset' | 'validate';
  providerId: string;
  data?: any;
}

export interface IpcParameterResponse {
  success: boolean;
  data?: any;
  error?: string;
}
