/**
 * Unit Tests for Parameter Processor
 *
 * Tests validation, merging, and processing logic for the dynamic parameter system.
 * Covers edge cases, boundary conditions, and error scenarios.
 *
 * NOTE: This is a TypeScript test file that can be run with basic node execution
 * since the project doesn't have a test framework configured yet.
 */

import { ParameterProcessor, PARAMETER_REGISTRY } from '../parameterProcessor';
import { ExtendedProvider, ParameterValue } from '../../../types/provider';

// Simple test assertion function
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`,
        );
      }
    },
    toContain: (expected: any) => {
      if (!actual.includes(expected)) {
        throw new Error(
          `Expected array to contain ${expected}, but got ${JSON.stringify(actual)}`,
        );
      }
    },
    toHaveLength: (expected: number) => {
      if (actual.length !== expected) {
        throw new Error(
          `Expected length ${expected}, but got ${actual.length}`,
        );
      }
    },
    toBeGreaterThan: (expected: number) => {
      if (actual <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeNull: () => {
      if (actual !== null) {
        throw new Error(`Expected null, but got ${actual}`);
      }
    },
    not: {
      toBeNull: () => {
        if (actual === null) {
          throw new Error(`Expected value not to be null`);
        }
      },
    },
  };
}

// Mock provider for testing
const mockProvider: ExtendedProvider = {
  id: 'test-provider',
  name: 'Test Provider',
  type: 'custom',
  isAi: true,
  apiKey: 'test-key',
  apiUrl: 'https://api.test.com',
  modelName: 'test-model',
  customParameters: {
    headerConfigs: {
      Authorization: 'Bearer ${API_KEY}',
      'X-Custom-Header': 'test-value',
    },
    bodyConfigs: {
      temperature: 0.8,
      max_tokens: 2000,
      stream: true,
      custom_param: 'custom-value',
    },
    templates: [],
    configVersion: '1.0.0',
    lastModified: Date.now(),
  },
};

const mockQwenProvider: ExtendedProvider = {
  id: 'qwen',
  name: 'Qwen Provider',
  type: 'qwen',
  isAi: true,
  apiKey: 'qwen-key',
  apiUrl: 'https://dashscope.aliyuncs.com',
  modelName: 'qwen-turbo',
  customParameters: {
    headerConfigs: {},
    bodyConfigs: {
      enable_thinking: true, // Should be overridden by hard-coded logic
      temperature: 0.5,
    },
    templates: [],
    configVersion: '1.0.0',
    lastModified: Date.now(),
  },
};

// Test runner function
function runTests() {
  console.log('Running Parameter Processor Tests...\n');

  // Test processCustomParameters
  console.log('Testing processCustomParameters...');

  // Test 1: Valid parameters processing
  try {
    const result = ParameterProcessor.processCustomParameters(mockProvider, {});

    expect(result.headers['Authorization']).toBe('Bearer test-key');
    expect(result.headers['X-Custom-Header']).toBe('test-value');
    expect(result.body.temperature).toBe(0.8);
    expect(result.body.max_tokens).toBe(2000);
    expect(result.body.stream).toBe(true);
    expect(result.appliedParameters).toContain('header:Authorization');
    expect(result.appliedParameters).toContain('body:temperature');
    expect(result.validationErrors).toHaveLength(0);
    console.log('✅ Valid parameters processing test passed');
  } catch (error) {
    console.log('❌ Valid parameters processing test failed:', error.message);
  }

  // Test 2: Provider without custom parameters
  try {
    const providerWithoutParams: ExtendedProvider = {
      id: 'simple',
      name: 'Simple Provider',
      type: 'simple',
      isAi: true,
      apiKey: 'key',
      apiUrl: 'url',
      modelName: 'model',
    };

    const result = ParameterProcessor.processCustomParameters(
      providerWithoutParams,
      {},
    );

    expect(Object.keys(result.headers)).toHaveLength(0);
    expect(result.appliedParameters).toHaveLength(0);
    expect(result.validationErrors).toHaveLength(0);
    console.log('✅ Provider without custom parameters test passed');
  } catch (error) {
    console.log(
      '❌ Provider without custom parameters test failed:',
      error.message,
    );
  }

  // Test 3: Hard-coded parameters precedence
  try {
    const result = ParameterProcessor.processCustomParameters(
      mockQwenProvider,
      {},
    );

    // Hard-coded logic should override custom parameter
    expect(result.body.enable_thinking).toBe(false);
    expect(result.appliedParameters).toContain('hardcoded:enable_thinking');
    expect(result.body.temperature).toBe(0.5); // Custom parameter should remain
    console.log('✅ Hard-coded parameters precedence test passed');
  } catch (error) {
    console.log(
      '❌ Hard-coded parameters precedence test failed:',
      error.message,
    );
  }

  // Test validateParameter
  console.log('\nTesting validateParameter...');

  // Test 4: Valid temperature parameter
  try {
    const result = ParameterProcessor.validateParameter(
      'temperature',
      0.5,
      mockProvider,
    );

    expect(result.isValid).toBe(true);
    expect(result.convertedValue).toBe(0.5);
    expect(result.errors).toHaveLength(0);
    console.log('✅ Valid temperature parameter test passed');
  } catch (error) {
    console.log('❌ Valid temperature parameter test failed:', error.message);
  }

  // Test 5: Temperature outside valid range
  try {
    const result = ParameterProcessor.validateParameter(
      'temperature',
      3.0,
      mockProvider,
    );

    expect(result.isValid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('range');
    console.log('✅ Temperature range validation test passed');
  } catch (error) {
    console.log('❌ Temperature range validation test failed:', error.message);
  }

  // Test 6: String to number conversion
  try {
    const result = ParameterProcessor.validateParameter(
      'temperature',
      '0.7',
      mockProvider,
    );

    expect(result.isValid).toBe(true);
    expect(result.convertedValue).toBe(0.7);
    console.log('✅ String to number conversion test passed');
  } catch (error) {
    console.log('❌ String to number conversion test failed:', error.message);
  }

  // Test 7: String to boolean conversion
  try {
    const trueResult = ParameterProcessor.validateParameter(
      'stream',
      'true',
      mockProvider,
    );
    const falseResult = ParameterProcessor.validateParameter(
      'stream',
      'false',
      mockProvider,
    );

    expect(trueResult.isValid).toBe(true);
    expect(trueResult.convertedValue).toBe(true);
    expect(falseResult.isValid).toBe(true);
    expect(falseResult.convertedValue).toBe(false);
    console.log('✅ String to boolean conversion test passed');
  } catch (error) {
    console.log('❌ String to boolean conversion test failed:', error.message);
  }

  // Test 8: Invalid number conversion
  try {
    const result = ParameterProcessor.validateParameter(
      'temperature',
      'not-a-number',
      mockProvider,
    );

    expect(result.isValid).toBe(false);
    expect(result.errors[0].type).toBe('type');
    console.log('✅ Invalid number conversion test passed');
  } catch (error) {
    console.log('❌ Invalid number conversion test failed:', error.message);
  }

  // Test 9: Unknown parameters allowed
  try {
    const result = ParameterProcessor.validateParameter(
      'unknown_param',
      'any-value',
      mockProvider,
    );

    expect(result.isValid).toBe(true);
    expect(result.convertedValue).toBe('any-value');
    console.log('✅ Unknown parameters allowed test passed');
  } catch (error) {
    console.log('❌ Unknown parameters allowed test failed:', error.message);
  }

  // Test mergeParameters
  console.log('\nTesting mergeParameters...');

  // Test 10: Parameter precedence in merging
  try {
    const hardCoded = { temperature: 1.0, stream: false };
    const custom = { temperature: 0.5, stream: true, max_tokens: 1000 };

    const result = ParameterProcessor.mergeParameters(hardCoded, custom);

    expect(result.temperature).toBe(1.0); // Hard-coded wins
    expect(result.stream).toBe(false); // Hard-coded wins
    expect(result.max_tokens).toBe(1000); // Custom parameter preserved
    console.log('✅ Parameter precedence in merging test passed');
  } catch (error) {
    console.log(
      '❌ Parameter precedence in merging test failed:',
      error.message,
    );
  }

  // Test getSupportedParameters
  console.log('\nTesting getSupportedParameters...');

  // Test 11: Wildcard support parameters
  try {
    const supported = ParameterProcessor.getSupportedParameters('any-provider');
    const wildcardParams = supported.filter((p) =>
      p.providerSupport.includes('*'),
    );

    expect(wildcardParams.length).toBeGreaterThan(0);
    console.log('✅ Wildcard support parameters test passed');
  } catch (error) {
    console.log('❌ Wildcard support parameters test failed:', error.message);
  }

  // Test 12: Provider-specific parameters
  try {
    const qwenSupported = ParameterProcessor.getSupportedParameters('qwen');
    const hasTopK = qwenSupported.some((p) => p.key === 'top_k');
    const hasEnableThinking = qwenSupported.some(
      (p) => p.key === 'enable_thinking',
    );

    expect(hasTopK).toBe(true);
    expect(hasEnableThinking).toBe(true);
    console.log('✅ Provider-specific parameters test passed');
  } catch (error) {
    console.log('❌ Provider-specific parameters test failed:', error.message);
  }

  // Test getParameterDefinition
  console.log('\nTesting getParameterDefinition...');

  // Test 13: Known parameter definition
  try {
    const definition = ParameterProcessor.getParameterDefinition('temperature');

    expect(definition).not.toBeNull();
    expect(definition?.key).toBe('temperature');
    expect(definition?.type).toBe('number');
    console.log('✅ Known parameter definition test passed');
  } catch (error) {
    console.log('❌ Known parameter definition test failed:', error.message);
  }

  // Test 14: Unknown parameter definition
  try {
    const definition =
      ParameterProcessor.getParameterDefinition('unknown_param');

    expect(definition).toBeNull();
    console.log('✅ Unknown parameter definition test passed');
  } catch (error) {
    console.log('❌ Unknown parameter definition test failed:', error.message);
  }

  // Test PARAMETER_REGISTRY
  console.log('\nTesting PARAMETER_REGISTRY...');

  // Test 15: Registry contains expected parameters
  try {
    const expectedParams = [
      'temperature',
      'max_tokens',
      'top_p',
      'stream',
      'enable_thinking',
    ];

    expectedParams.forEach((param) => {
      if (!PARAMETER_REGISTRY[param]) {
        throw new Error(`Missing parameter: ${param}`);
      }
      if (PARAMETER_REGISTRY[param].key !== param) {
        throw new Error(`Parameter key mismatch for: ${param}`);
      }
    });
    console.log('✅ Registry contains expected parameters test passed');
  } catch (error) {
    console.log(
      '❌ Registry contains expected parameters test failed:',
      error.message,
    );
  }

  // Test 16: Registry validation rules
  try {
    Object.values(PARAMETER_REGISTRY).forEach((param) => {
      if (!param.key) throw new Error(`Missing key for parameter`);
      if (!param.type)
        throw new Error(`Missing type for parameter ${param.key}`);
      if (!param.category)
        throw new Error(`Missing category for parameter ${param.key}`);
      if (!Array.isArray(param.providerSupport))
        throw new Error(`Invalid providerSupport for parameter ${param.key}`);

      if (param.validation) {
        if (param.type === 'number') {
          if (
            param.validation.min !== undefined &&
            typeof param.validation.min !== 'number'
          ) {
            throw new Error(
              `Invalid min validation for parameter ${param.key}`,
            );
          }
          if (
            param.validation.max !== undefined &&
            typeof param.validation.max !== 'number'
          ) {
            throw new Error(
              `Invalid max validation for parameter ${param.key}`,
            );
          }
        }
      }
    });
    console.log('✅ Registry validation rules test passed');
  } catch (error) {
    console.log('❌ Registry validation rules test failed:', error.message);
  }

  console.log('\n🎉 All tests completed!');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests();
}

export { runTests };
