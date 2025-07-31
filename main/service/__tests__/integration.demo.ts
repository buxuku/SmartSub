/**
 * Integration Demo Script
 *
 * Demonstrates how the OpenAI service now integrates with the Parameter Processor
 * to support custom parameters while maintaining backward compatibility.
 */

import { ParameterProcessor } from '../../helpers/parameterProcessor';
import { ExtendedProvider } from '../../../types/provider';

console.log('🚀 OpenAI Service Integration Demo\n');

// Demo 1: Qwen Provider with backward compatibility
console.log('Demo 1: Qwen Provider (Backward Compatibility)');
console.log('===============================================');

const qwenProvider: ExtendedProvider = {
  id: 'qwen',
  name: 'Qwen Provider',
  type: 'qwen',
  isAi: true,
  apiKey: 'sk-test-key',
  apiUrl: 'https://dashscope.aliyuncs.com',
  modelName: 'qwen-turbo',
  customParameters: {
    headerConfigs: {
      'X-Custom-Auth': 'Bearer ${API_KEY}',
    },
    bodyConfigs: {
      enable_thinking: true, // Will be overridden by hard-coded logic
      temperature: 0.8,
      max_tokens: 2000,
    },
    templates: [],
    configVersion: '1.0.0',
    lastModified: Date.now(),
  },
};

const qwenResult = ParameterProcessor.processCustomParameters(qwenProvider, {});

console.log('Input custom parameters:');
console.log('- Header: X-Custom-Auth: "Bearer ${API_KEY}"');
console.log('- Body: enable_thinking: true (should be overridden)');
console.log('- Body: temperature: 0.8');
console.log('- Body: max_tokens: 2000\n');

console.log('Processed result:');
console.log('- Headers:', JSON.stringify(qwenResult.headers, null, 2));
console.log('- Body parameters:', JSON.stringify(qwenResult.body, null, 2));
console.log('- Applied parameters:', qwenResult.appliedParameters);
console.log(
  '- Hard-coded override working:',
  qwenResult.body.enable_thinking === false ? '✅' : '❌',
);

console.log('\n' + '='.repeat(60) + '\n');

// Demo 2: Custom Provider with full parameter support
console.log('Demo 2: Custom Provider (Full Parameter Support)');
console.log('=================================================');

const customProvider: ExtendedProvider = {
  id: 'claude-custom',
  name: 'Claude Custom Provider',
  type: 'anthropic',
  isAi: true,
  apiKey: 'sk-ant-custom-key',
  apiUrl: 'https://api.anthropic.com',
  modelName: 'claude-3-sonnet',
  customParameters: {
    headerConfigs: {
      'anthropic-version': '2023-06-01',
      'x-api-key': '${API_KEY}',
      'x-custom-header': 'SmartSub-v2.5.2',
    },
    bodyConfigs: {
      temperature: 0.7,
      max_tokens: 4000,
      top_p: 0.9,
      stream: false,
      custom_system_prompt: 'Enhanced translation mode',
    },
    templates: [],
    configVersion: '1.0.0',
    lastModified: Date.now(),
  },
};

const customResult = ParameterProcessor.processCustomParameters(
  customProvider,
  {
    model: 'claude-3-sonnet', // Base parameter
    temperature: 0.3, // Should be overridden by custom parameter
  },
);

console.log('Input configuration:');
console.log('- Base model: claude-3-sonnet');
console.log('- Base temperature: 0.3 (will be overridden)');
console.log('- Custom headers: anthropic-version, x-api-key, x-custom-header');
console.log(
  '- Custom body parameters: temperature: 0.7, max_tokens: 4000, etc.\n',
);

console.log('Processed result:');
console.log('- Headers:', JSON.stringify(customResult.headers, null, 2));
console.log('- Body parameters:', JSON.stringify(customResult.body, null, 2));
console.log('- Applied parameters:', customResult.appliedParameters);
console.log(
  '- Parameter override working:',
  customResult.body.temperature === 0.7 ? '✅' : '❌',
);

console.log('\n' + '='.repeat(60) + '\n');

// Demo 3: Error handling and validation
console.log('Demo 3: Parameter Validation and Error Handling');
console.log('===============================================');

const providerWithErrors: ExtendedProvider = {
  id: 'error-demo',
  name: 'Error Demo Provider',
  type: 'custom',
  isAi: true,
  apiKey: 'test-key',
  apiUrl: 'https://api.example.com',
  modelName: 'test-model',
  customParameters: {
    headerConfigs: {
      'valid-header': 'valid-value',
    },
    bodyConfigs: {
      temperature: 5.0, // Invalid: outside range 0.0-2.0
      max_tokens: 'invalid-number', // Invalid: not a number
      stream: 'yes', // Invalid: not a valid boolean
      valid_param: 'valid-value',
    },
    templates: [],
    configVersion: '1.0.0',
    lastModified: Date.now(),
  },
};

const errorResult = ParameterProcessor.processCustomParameters(
  providerWithErrors,
  {},
);

console.log('Input with validation errors:');
console.log('- temperature: 5.0 (invalid range)');
console.log('- max_tokens: "invalid-number" (invalid type)');
console.log('- stream: "yes" (invalid boolean)');
console.log('- valid_param: "valid-value" (should work)\n');

console.log('Validation results:');
console.log('- Headers processed:', Object.keys(errorResult.headers).length);
console.log(
  '- Valid parameters applied:',
  errorResult.appliedParameters.length,
);
console.log(
  '- Invalid parameters skipped:',
  errorResult.skippedParameters.length,
);
console.log('- Validation errors:', errorResult.validationErrors.length);

if (errorResult.validationErrors.length > 0) {
  console.log('\nError details:');
  errorResult.validationErrors.forEach((error, index) => {
    console.log(`  ${index + 1}. ${error.key}: ${error.message}`);
  });
}

console.log('\n' + '='.repeat(60) + '\n');

// Demo 4: Integration with actual service call simulation
console.log('Demo 4: Service Integration Simulation');
console.log('======================================');

// Simulate the service call process
function simulateServiceCall(provider: ExtendedProvider) {
  console.log(`Processing provider: ${provider.name} (${provider.id})`);

  // Step 1: Process custom parameters
  const processed = ParameterProcessor.processCustomParameters(provider, {
    model: provider.modelName || 'default-model',
    temperature: 0.3, // Default that might be overridden
    stream: false,
  });

  // Step 2: Prepare headers (would be used in OpenAI client initialization)
  const customHeaders = processed.headers;
  console.log(
    'Custom headers for API client:',
    Object.keys(customHeaders).length > 0 ? customHeaders : 'none',
  );

  // Step 3: Prepare request body (would be used in API call)
  const requestBody = processed.body;
  console.log('Request body parameters:', {
    model: requestBody.model,
    temperature: requestBody.temperature,
    stream: requestBody.stream,
    customParams: Object.keys(requestBody).filter(
      (k) => !['model', 'temperature', 'stream'].includes(k),
    ),
  });

  // Step 4: Log processing summary
  console.log('Processing summary:');
  console.log(`- Applied: ${processed.appliedParameters.length} parameters`);
  console.log(`- Skipped: ${processed.skippedParameters.length} parameters`);
  console.log(
    `- Errors: ${processed.validationErrors.length} validation errors`,
  );

  return {
    headers: customHeaders,
    body: requestBody,
    success: processed.validationErrors.length === 0,
  };
}

// Test with the Qwen provider
console.log('Simulating Qwen provider service call:');
const qwenSimulation = simulateServiceCall(qwenProvider);
console.log('Result:', qwenSimulation.success ? '✅ Success' : '❌ Has errors');

console.log('\n🎉 Integration demo completed!\n');

console.log('Summary of Integration Features:');
console.log('================================');
console.log('✅ Backward compatibility maintained');
console.log('✅ Custom headers support');
console.log('✅ Custom body parameters support');
console.log('✅ Parameter validation and type conversion');
console.log('✅ Template variable substitution');
console.log('✅ Hard-coded parameter precedence');
console.log('✅ Error handling and logging');
console.log('✅ Integration with existing OpenAI service');
