/**
 * DynamicParameterInput Demo Component
 *
 * Demonstrates the DynamicParameterInput component with different parameter types.
 * This is for testing and development purposes.
 */

import React, { useState } from 'react';
import { DynamicParameterInput } from './DynamicParameterInput';
import {
  ParameterValue,
  ParameterDefinition,
  ValidationError,
} from '../../types/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const DynamicParameterInputDemo: React.FC = () => {
  const [values, setValues] = useState<Record<string, ParameterValue>>({
    stringParam: 'Hello World',
    integerParam: 42,
    floatParam: 0.7,
    booleanParam: true,
    arrayParam: ['item1', 'item2'],
    objectParam: { key: 'value', nested: { count: 1 } },
  });

  const [errors, setErrors] = useState<Record<string, ValidationError[]>>({});

  // Sample parameter definitions
  const definitions: Record<string, ParameterDefinition> = {
    stringParam: {
      key: 'stringParam',
      type: 'string',
      category: 'core',
      required: true,
      description: 'A simple string parameter for text input',
      providerSupport: ['openai', 'claude'],
    },
    integerParam: {
      key: 'integerParam',
      type: 'integer',
      category: 'performance',
      required: false,
      description: 'An integer parameter with validation',
      validation: { min: 0, max: 100 },
      providerSupport: ['openai'],
    },
    floatParam: {
      key: 'floatParam',
      type: 'float',
      category: 'performance',
      required: false,
      description: 'A floating point parameter with validation',
      validation: { min: 0.0, max: 1.0 },
      providerSupport: ['openai'],
    },
    booleanParam: {
      key: 'booleanParam',
      type: 'boolean',
      category: 'behavior',
      required: false,
      description: 'A toggle switch for boolean values',
      providerSupport: ['openai', 'claude', 'deepseek'],
    },
    arrayParam: {
      key: 'arrayParam',
      type: 'array',
      category: 'core',
      required: false,
      description: 'An array parameter with dynamic item management',
      providerSupport: ['openai'],
    },
    objectParam: {
      key: 'objectParam',
      type: 'object',
      category: 'core',
      required: false,
      description: 'A JSON object parameter with syntax validation',
      providerSupport: ['openai', 'claude'],
    },
  };

  const handleParameterChange = (key: string, value: ParameterValue) => {
    setValues((prev) => ({
      ...prev,
      [key]: value,
    }));

    // Simulate validation
    const newErrors: ValidationError[] = [];

    if (key === 'integerParam' && typeof value === 'number') {
      if (value < 0 || value > 100) {
        newErrors.push({
          key,
          type: 'range',
          message: 'Value must be between 0 and 100',
          suggestion: 'Enter an integer in the valid range',
        });
      }
    }

    if (key === 'floatParam' && typeof value === 'number') {
      if (value < 0.0 || value > 1.0) {
        newErrors.push({
          key,
          type: 'range',
          message: 'Value must be between 0.0 and 1.0',
          suggestion: 'Enter a float in the valid range',
        });
      }
    }

    if (key === 'stringParam' && (!value || value.toString().length < 3)) {
      newErrors.push({
        key,
        type: 'format',
        message: 'String must be at least 3 characters long',
        suggestion: 'Please enter more text',
      });
    }

    setErrors((prev) => ({
      ...prev,
      [key]: newErrors,
    }));
  };

  const handleParameterRemove = (key: string) => {
    setValues((prev) => {
      const { [key]: removed, ...rest } = prev;
      return rest;
    });
    setErrors((prev) => {
      const { [key]: removed, ...rest } = prev;
      return rest;
    });
  };

  const resetDemo = () => {
    setValues({
      stringParam: 'Hello World',
      integerParam: 42,
      floatParam: 0.7,
      booleanParam: true,
      arrayParam: ['item1', 'item2'],
      objectParam: { key: 'value', nested: { count: 1 } },
    });
    setErrors({});
  };

  const addNewParameter = () => {
    const newKey = `customParam${Object.keys(values).length}`;
    setValues((prev) => ({
      ...prev,
      [newKey]: '',
    }));
  };

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Dynamic Parameter Input Demo</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 mb-6">
            <Button onClick={resetDemo} variant="outline">
              Reset Demo
            </Button>
            <Button onClick={addNewParameter} variant="outline">
              Add Custom Parameter
            </Button>
          </div>

          <div className="space-y-4">
            {Object.entries(values).map(([key, value]) => (
              <DynamicParameterInput
                key={key}
                parameterKey={key}
                value={value}
                definition={definitions[key]}
                errors={errors[key] || []}
                onChange={handleParameterChange}
                onRemove={handleParameterRemove}
                showRemove={!definitions[key]?.required}
              />
            ))}
          </div>

          <div className="mt-8 p-4 bg-muted rounded-lg">
            <h3 className="text-sm font-medium mb-2">Current Values:</h3>
            <pre className="text-xs overflow-auto">
              {JSON.stringify(values, null, 2)}
            </pre>
          </div>

          {Object.keys(errors).length > 0 && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <h3 className="text-sm font-medium text-red-800 mb-2">
                Validation Errors:
              </h3>
              <pre className="text-xs text-red-700 overflow-auto">
                {JSON.stringify(errors, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default DynamicParameterInputDemo;
