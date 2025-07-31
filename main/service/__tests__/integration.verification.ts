/**
 * Integration Verification Script
 *
 * Verifies that the OpenAI service integration with Parameter Processor
 * maintains backward compatibility and processes parameters correctly.
 */

import { ParameterProcessor } from '../../helpers/parameterProcessor';
import { ExtendedProvider } from '../../../types/provider';

// Simple test assertion function
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, but got ${actual}`);
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
  };
}

// Test the integration scenarios
function runIntegrationTests() {
  console.log('Running OpenAI Service Integration Tests...\n');

  // Test 1: Qwen thinking mode backward compatibility
  console.log('Test 1: Qwen thinking mode backward compatibility...');
  try {
    const qwenProvider: ExtendedProvider = {
      id: 'qwen',
      name: 'Qwen Provider',
      type: 'qwen',
      isAi: true,
      apiKey: 'test-key',
      apiUrl: 'https://dashscope.aliyuncs.com',
      modelName: 'qwen-turbo',
      customParameters: {
        headerConfigs: {},
        bodyConfigs: {
          enable_thinking: true, // Should be overridden
          temperature: 0.8,
        },
        templates: [],
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
    };

    const result = ParameterProcessor.processCustomParameters(qwenProvider, {});

    expect(result.body.enable_thinking).toBe(false); // Hard-coded override
    expect(result.appliedParameters).toContain('hardcoded:enable_thinking');
    expect(result.body.temperature).toBe(0.8); // Custom parameter preserved
    console.log('✅ Qwen thinking mode backward compatibility test passed');
  } catch (error) {
    console.log('❌ Qwen thinking mode test failed:', error.message);
  }

  // Test 2: Custom headers processing
  console.log('\nTest 2: Custom headers processing...');
  try {
    const providerWithHeaders: ExtendedProvider = {
      id: 'custom-provider',
      name: 'Custom Provider',
      type: 'custom',
      isAi: true,
      apiKey: 'secret-123',
      apiUrl: 'https://api.custom.com',
      modelName: 'custom-model-v1',
      customParameters: {
        headerConfigs: {
          Authorization: 'Bearer ${API_KEY}',
          'X-Custom-Header': 'custom-value',
          'X-Model-Info': '${MODEL_NAME}-enhanced',
        },
        bodyConfigs: {
          temperature: 0.7,
          max_tokens: 2000,
        },
        templates: [],
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
    };

    const result = ParameterProcessor.processCustomParameters(
      providerWithHeaders,
      {},
    );

    expect(result.headers['Authorization']).toBe('Bearer secret-123');
    expect(result.headers['X-Custom-Header']).toBe('custom-value');
    expect(result.headers['X-Model-Info']).toBe('custom-model-v1-enhanced');
    expect(result.body.temperature).toBe(0.7);
    expect(result.body.max_tokens).toBe(2000);
    console.log('✅ Custom headers processing test passed');
  } catch (error) {
    console.log('❌ Custom headers processing test failed:', error.message);
  }

  // Test 3: Parameter validation
  console.log('\nTest 3: Parameter validation...');
  try {
    const providerWithInvalidParams: ExtendedProvider = {
      id: 'validation-test',
      name: 'Validation Test Provider',
      type: 'test',
      isAi: true,
      apiKey: 'key',
      apiUrl: 'url',
      modelName: 'model',
      customParameters: {
        headerConfigs: {},
        bodyConfigs: {
          temperature: 5.0, // Invalid range
          max_tokens: 'not-a-number', // Invalid type
          stream: 'true', // Valid conversion
        },
        templates: [],
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
    };

    const result = ParameterProcessor.processCustomParameters(
      providerWithInvalidParams,
      {},
    );

    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.skippedParameters.length).toBeGreaterThan(0);
    expect(result.body.stream).toBe(true); // Should convert 'true' to boolean
    console.log('✅ Parameter validation test passed');
  } catch (error) {
    console.log('❌ Parameter validation test failed:', error.message);
  }

  // Test 4: Provider without custom parameters
  console.log('\nTest 4: Provider without custom parameters...');
  try {
    const simpleProvider: ExtendedProvider = {
      id: 'simple',
      name: 'Simple Provider',
      type: 'simple',
      isAi: true,
      apiKey: 'key',
      apiUrl: 'url',
      modelName: 'model',
    };

    const result = ParameterProcessor.processCustomParameters(
      simpleProvider,
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

  // Test 5: Parameter merging with base parameters
  console.log('\nTest 5: Parameter merging with base parameters...');
  try {
    const mergeProvider: ExtendedProvider = {
      id: 'merge-test',
      name: 'Merge Test',
      type: 'custom',
      isAi: true,
      apiKey: 'key',
      apiUrl: 'url',
      modelName: 'model',
      customParameters: {
        headerConfigs: {},
        bodyConfigs: {
          temperature: 0.9,
          custom_param: 'custom-value',
        },
        templates: [],
        configVersion: '1.0.0',
        lastModified: Date.now(),
      },
    };

    const baseParams = {
      existing_param: 'base-value',
      temperature: 0.3, // Should be overridden
    };

    const result = ParameterProcessor.processCustomParameters(
      mergeProvider,
      baseParams,
    );

    expect(result.body.existing_param).toBe('base-value');
    expect(result.body.temperature).toBe(0.9); // Custom overrides base
    expect(result.body.custom_param).toBe('custom-value');
    console.log('✅ Parameter merging test passed');
  } catch (error) {
    console.log('❌ Parameter merging test failed:', error.message);
  }

  console.log('\n🎉 All integration tests completed!');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runIntegrationTests();
}

export { runIntegrationTests };
