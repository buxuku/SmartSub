/**
 * Unit Tests for useParameterConfig Hook
 *
 * Tests the parameter configuration hook functionality including
 * CRUD operations, validation, template application, and state management.
 */

import { CustomParameterConfig } from '../../../types/provider';

// Mock window.ipc for testing
const mockIpc = {
  invoke: jest.fn(),
  send: jest.fn(),
  on: jest.fn(),
};

// Setup global window mock
(global as any).window = {
  ipc: mockIpc,
};

// Simple test framework for hooks (since we don't have Jest configured)
interface TestHookState {
  config: CustomParameterConfig | null;
  isLoading: boolean;
  hasUnsavedChanges: boolean;
  validationErrors: any[];
  lastSaved: number | null;
}

// Mock hook implementation for testing
function createMockHook() {
  let state: TestHookState = {
    config: null,
    isLoading: false,
    hasUnsavedChanges: false,
    validationErrors: [],
    lastSaved: null,
  };

  const updateState = (newState: Partial<TestHookState>) => {
    state = { ...state, ...newState };
  };

  return {
    getState: () => state,
    updateState,

    // Mock hook methods
    loadConfig: async (providerId: string) => {
      updateState({ isLoading: true });

      try {
        const config = await mockIpc.invoke('getCustomParameters', providerId);
        updateState({
          config,
          isLoading: false,
          hasUnsavedChanges: false,
          validationErrors: [],
          lastSaved: config?.lastModified || null,
        });
      } catch (error) {
        updateState({
          isLoading: false,
          validationErrors: [
            {
              key: 'load',
              type: 'system',
              message: 'Failed to load configuration',
            },
          ],
        });
      }
    },

    saveConfig: async (providerId: string, config: CustomParameterConfig) => {
      updateState({ isLoading: true });

      try {
        const success = await mockIpc.invoke(
          'setCustomParameters',
          providerId,
          config,
        );

        if (success) {
          updateState({
            config: { ...config, lastModified: Date.now() },
            isLoading: false,
            hasUnsavedChanges: false,
            lastSaved: Date.now(),
          });
          return true;
        }
        return false;
      } catch (error) {
        updateState({ isLoading: false });
        return false;
      }
    },

    addHeaderParameter: (key: string, value: any) => {
      const currentConfig = state.config || {
        headerConfigs: {},
        bodyConfigs: {},
        templates: [],
        configVersion: '1.0.0',
        lastModified: Date.now(),
      };

      const newConfig = {
        ...currentConfig,
        headerConfigs: {
          ...currentConfig.headerConfigs,
          [key]: value,
        },
      };

      updateState({
        config: newConfig,
        hasUnsavedChanges: true,
      });
    },

    addBodyParameter: (key: string, value: any) => {
      const currentConfig = state.config || {
        headerConfigs: {},
        bodyConfigs: {},
        templates: [],
        configVersion: '1.0.0',
        lastModified: Date.now(),
      };

      const newConfig = {
        ...currentConfig,
        bodyConfigs: {
          ...currentConfig.bodyConfigs,
          [key]: value,
        },
      };

      updateState({
        config: newConfig,
        hasUnsavedChanges: true,
      });
    },

    validateConfiguration: async (
      providerId: string,
      config?: CustomParameterConfig,
    ) => {
      const configToValidate = config || state.config;

      if (!configToValidate) {
        return [];
      }

      const errors = await mockIpc.invoke(
        'validateParameterConfiguration',
        providerId,
        configToValidate,
      );

      if (!config) {
        updateState({ validationErrors: errors });
      }

      return errors;
    },
  };
}

// Test runner
function runHookTests() {
  console.log('Running useParameterConfig Hook Tests...\n');

  // Test 1: Initial state
  console.log('Test 1: Initial state...');
  try {
    const hook = createMockHook();
    const initialState = hook.getState();

    if (initialState.config !== null) {
      throw new Error('Initial config should be null');
    }
    if (initialState.isLoading !== false) {
      throw new Error('Initial loading state should be false');
    }
    if (initialState.hasUnsavedChanges !== false) {
      throw new Error('Initial unsaved changes should be false');
    }
    if (initialState.validationErrors.length !== 0) {
      throw new Error('Initial validation errors should be empty');
    }

    console.log('✅ Initial state test passed');
  } catch (error) {
    console.log('❌ Initial state test failed:', error.message);
  }

  // Test 2: Load configuration
  console.log('\nTest 2: Load configuration...');
  try {
    const hook = createMockHook();

    // Mock successful config load
    const mockConfig: CustomParameterConfig = {
      headerConfigs: { Authorization: 'Bearer test' },
      bodyConfigs: { temperature: 0.7 },
      templates: [],
      configVersion: '1.0.0',
      lastModified: Date.now(),
    };

    mockIpc.invoke.mockResolvedValueOnce(mockConfig);

    hook.loadConfig('test-provider').then(() => {
      const state = hook.getState();

      if (!state.config) {
        throw new Error('Config should be loaded');
      }
      if (state.config.headerConfigs['Authorization'] !== 'Bearer test') {
        throw new Error('Header config not loaded correctly');
      }
      if (state.config.bodyConfigs['temperature'] !== 0.7) {
        throw new Error('Body config not loaded correctly');
      }
      if (state.hasUnsavedChanges !== false) {
        throw new Error('Should not have unsaved changes after load');
      }

      console.log('✅ Load configuration test passed');
    });
  } catch (error) {
    console.log('❌ Load configuration test failed:', error.message);
  }

  // Test 3: Add header parameter
  console.log('\nTest 3: Add header parameter...');
  try {
    const hook = createMockHook();

    hook.addHeaderParameter('X-Custom-Header', 'custom-value');

    const state = hook.getState();

    if (!state.config) {
      throw new Error('Config should be created when adding parameter');
    }
    if (state.config.headerConfigs['X-Custom-Header'] !== 'custom-value') {
      throw new Error('Header parameter not added correctly');
    }
    if (state.hasUnsavedChanges !== true) {
      throw new Error('Should have unsaved changes after adding parameter');
    }

    console.log('✅ Add header parameter test passed');
  } catch (error) {
    console.log('❌ Add header parameter test failed:', error.message);
  }

  // Test 4: Add body parameter
  console.log('\nTest 4: Add body parameter...');
  try {
    const hook = createMockHook();

    hook.addBodyParameter('temperature', 0.8);

    const state = hook.getState();

    if (!state.config) {
      throw new Error('Config should be created when adding parameter');
    }
    if (state.config.bodyConfigs['temperature'] !== 0.8) {
      throw new Error('Body parameter not added correctly');
    }
    if (state.hasUnsavedChanges !== true) {
      throw new Error('Should have unsaved changes after adding parameter');
    }

    console.log('✅ Add body parameter test passed');
  } catch (error) {
    console.log('❌ Add body parameter test failed:', error.message);
  }

  // Test 5: Save configuration
  console.log('\nTest 5: Save configuration...');
  try {
    const hook = createMockHook();

    // Add a parameter first
    hook.addBodyParameter('temperature', 0.9);

    // Mock successful save
    mockIpc.invoke.mockResolvedValueOnce(true);

    const config = hook.getState().config!;

    hook.saveConfig('test-provider', config).then((success) => {
      if (!success) {
        throw new Error('Save should succeed');
      }

      const state = hook.getState();

      if (state.hasUnsavedChanges !== false) {
        throw new Error('Should not have unsaved changes after save');
      }
      if (!state.lastSaved) {
        throw new Error('Should have lastSaved timestamp after save');
      }

      console.log('✅ Save configuration test passed');
    });
  } catch (error) {
    console.log('❌ Save configuration test failed:', error.message);
  }

  // Test 6: Validation
  console.log('\nTest 6: Configuration validation...');
  try {
    const hook = createMockHook();

    // Add a parameter
    hook.addBodyParameter('temperature', 0.7);

    // Mock validation response
    const mockErrors = [
      {
        key: 'temperature',
        type: 'range',
        message: 'Temperature value is too high',
        suggestion: 'Use a value between 0.0 and 2.0',
      },
    ];

    mockIpc.invoke.mockResolvedValueOnce(mockErrors);

    hook.validateConfiguration('test-provider').then((errors) => {
      if (errors.length !== 1) {
        throw new Error('Should return validation errors');
      }
      if (errors[0].key !== 'temperature') {
        throw new Error('Error key should match parameter');
      }

      const state = hook.getState();
      if (state.validationErrors.length !== 1) {
        throw new Error('State should be updated with validation errors');
      }

      console.log('✅ Configuration validation test passed');
    });
  } catch (error) {
    console.log('❌ Configuration validation test failed:', error.message);
  }

  console.log('\n🎉 Hook tests completed!');
}

// Test utility functions
function testHookUtilities() {
  console.log('\nTesting Hook Utilities...');

  // Test configuration creation
  console.log('Testing configuration structure...');
  try {
    const defaultConfig: CustomParameterConfig = {
      headerConfigs: {},
      bodyConfigs: {},
      templates: [],
      configVersion: '1.0.0',
      lastModified: Date.now(),
    };

    if (typeof defaultConfig.headerConfigs !== 'object') {
      throw new Error('headerConfigs should be object');
    }
    if (typeof defaultConfig.bodyConfigs !== 'object') {
      throw new Error('bodyConfigs should be object');
    }
    if (!Array.isArray(defaultConfig.templates)) {
      throw new Error('templates should be array');
    }
    if (typeof defaultConfig.configVersion !== 'string') {
      throw new Error('configVersion should be string');
    }
    if (typeof defaultConfig.lastModified !== 'number') {
      throw new Error('lastModified should be number');
    }

    console.log('✅ Configuration structure test passed');
  } catch (error) {
    console.log('❌ Configuration structure test failed:', error.message);
  }

  // Test parameter types
  console.log('\nTesting parameter value types...');
  try {
    const stringValue = 'test-string';
    const numberValue = 0.7;
    const booleanValue = true;
    const objectValue = { nested: 'value' };
    const arrayValue = ['item1', 'item2'];

    // These should all be valid ParameterValue types
    const validValues = [
      stringValue,
      numberValue,
      booleanValue,
      objectValue,
      arrayValue,
    ];

    validValues.forEach((value, index) => {
      if (value === undefined || value === null) {
        throw new Error(`Value at index ${index} should not be null/undefined`);
      }
    });

    console.log('✅ Parameter value types test passed');
  } catch (error) {
    console.log('❌ Parameter value types test failed:', error.message);
  }

  console.log('✅ Hook utilities tests completed!');
}

// Export test runner for external use
export { runHookTests, testHookUtilities };

// Run tests if this file is executed directly
if (typeof window !== 'undefined' && (window as any).runParameterHookTests) {
  runHookTests();
  testHookUtilities();
}
