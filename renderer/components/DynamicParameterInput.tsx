/**
 * DynamicParameterInput Component
 *
 * Renders different input types based on parameter type with real-time validation.
 * Supports string, number, boolean, object, and array parameter types.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Trash2,
  Plus,
  AlertCircle,
  CheckCircle2,
  Info,
  Code,
} from 'lucide-react';
import {
  ParameterValue,
  ParameterDefinition,
  ValidationError,
} from '../../types/provider';
import { cn } from 'lib/utils';

export interface DynamicParameterInputProps {
  /** Parameter key identifier */
  parameterKey: string;
  /** Current parameter value */
  value: ParameterValue;
  /** Parameter definition with type and validation rules */
  definition?: ParameterDefinition;
  /** Validation errors for this parameter */
  errors?: ValidationError[];
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Called when the value changes */
  onChange: (key: string, value: ParameterValue) => void;
  /** Called when the parameter should be removed */
  onRemove?: (key: string) => void;
  /** Whether to show the remove button */
  showRemove?: boolean;
  /** Additional CSS classes */
  className?: string;
}

export const DynamicParameterInput: React.FC<DynamicParameterInputProps> = ({
  parameterKey,
  value,
  definition,
  errors = [],
  disabled = false,
  placeholder,
  onChange,
  onRemove,
  showRemove = false,
  className,
}) => {
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isJsonValid, setIsJsonValid] = useState(true);

  // Determine the parameter type
  const parameterType = definition?.type || 'string';
  const hasErrors = errors.length > 0;
  const isRequired = definition?.required || false;

  // Validate JSON input for object and array types
  const validateJson = useCallback((jsonString: string): boolean => {
    if (!jsonString.trim()) {
      setJsonError(null);
      setIsJsonValid(true);
      return true;
    }

    try {
      JSON.parse(jsonString);
      setJsonError(null);
      setIsJsonValid(true);
      return true;
    } catch (error) {
      setJsonError(
        `Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      setIsJsonValid(false);
      return false;
    }
  }, []);

  // Handle string input changes
  const handleStringChange = useCallback(
    (newValue: string) => {
      onChange(parameterKey, newValue);
    },
    [parameterKey, onChange],
  );

  // Handle integer input changes
  const handleIntegerChange = useCallback(
    (newValue: string) => {
      const numericValue = parseInt(newValue, 10);
      onChange(parameterKey, isNaN(numericValue) ? 0 : numericValue);
    },
    [parameterKey, onChange],
  );

  // Handle float input changes
  const handleFloatChange = useCallback(
    (newValue: string) => {
      const numericValue = parseFloat(newValue);
      onChange(parameterKey, isNaN(numericValue) ? 0 : numericValue);
    },
    [parameterKey, onChange],
  );

  // Handle boolean input changes
  const handleBooleanChange = useCallback(
    (checked: boolean) => {
      onChange(parameterKey, checked);
    },
    [parameterKey, onChange],
  );

  // Handle object/array JSON input changes
  const handleJsonChange = useCallback(
    (jsonString: string) => {
      if (validateJson(jsonString)) {
        try {
          const parsedValue = jsonString.trim()
            ? JSON.parse(jsonString)
            : parameterType === 'array'
              ? []
              : {};
          onChange(parameterKey, parsedValue);
        } catch {
          // Keep the current value if JSON is invalid
        }
      }
    },
    [parameterKey, onChange, validateJson, parameterType],
  );

  // Format JSON for display
  const formatJsonValue = useCallback(
    (val: any): string => {
      if (val === null || val === undefined) {
        return parameterType === 'array' ? '[]' : '{}';
      }
      try {
        return JSON.stringify(val, null, 2);
      } catch {
        return parameterType === 'array' ? '[]' : '{}';
      }
    },
    [parameterType],
  );

  // Array item management for array types
  const handleArrayItemAdd = useCallback(() => {
    const currentArray = Array.isArray(value) ? value : [];
    const newArray = [...currentArray, ''];
    onChange(parameterKey, newArray);
  }, [value, parameterKey, onChange]);

  const handleArrayItemChange = useCallback(
    (index: number, itemValue: string) => {
      const currentArray = Array.isArray(value) ? value : [];
      const newArray = [...currentArray];
      newArray[index] = itemValue;
      onChange(parameterKey, newArray);
    },
    [value, parameterKey, onChange],
  );

  const handleArrayItemRemove = useCallback(
    (index: number) => {
      const currentArray = Array.isArray(value) ? value : [];
      const newArray = currentArray.filter((_, i) => i !== index);
      onChange(parameterKey, newArray);
    },
    [value, parameterKey, onChange],
  );

  // Render validation messages
  const renderValidationMessages = () => {
    const allErrors = [...errors];
    if (jsonError) {
      allErrors.push({
        key: parameterKey,
        type: 'format',
        message: jsonError,
        suggestion: 'Please provide valid JSON syntax',
      });
    }

    // Check if there's meaningful input before showing "Valid" status
    const hasValue = value !== null && value !== undefined && value !== '';
    const isCompleteInput =
      hasValue &&
      ((typeof value === 'string' && value.trim().length > 0) ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (typeof value === 'object' && value !== null));

    if (allErrors.length === 0 && isJsonValid && isCompleteInput) {
      return (
        <div className="flex items-center gap-1 text-xs text-green-600 mt-1">
          <CheckCircle2 className="h-3 w-3" />
          <span>Valid</span>
        </div>
      );
    }

    return allErrors.map((error, index) => (
      <div
        key={index}
        className="flex items-start gap-1 text-xs text-red-600 mt-1"
      >
        <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
        <div>
          <div>{error.message}</div>
          {error.suggestion && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {error.suggestion}
            </div>
          )}
        </div>
      </div>
    ));
  };

  // Render parameter info
  const renderParameterInfo = () => {
    if (!definition?.description) return null;

    return (
      <div className="flex items-start gap-1 text-xs text-muted-foreground mb-2">
        <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
        <span>{definition.description}</span>
      </div>
    );
  };

  // Render the appropriate input based on parameter type
  const renderInput = () => {
    const baseClassName = cn(
      'w-full',
      hasErrors && 'border-red-500 focus-visible:ring-red-500',
    );

    switch (parameterType) {
      case 'string':
        return (
          <Input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => handleStringChange(e.target.value)}
            placeholder={placeholder || `Enter ${parameterKey}`}
            disabled={disabled}
            className={baseClassName}
          />
        );

      case 'integer':
        return (
          <Input
            type="number"
            step="1"
            value={typeof value === 'number' ? Math.floor(value) : ''}
            onChange={(e) => handleIntegerChange(e.target.value)}
            placeholder={placeholder || '0'}
            disabled={disabled}
            className={baseClassName}
            min={definition?.validation?.min}
            max={definition?.validation?.max}
          />
        );

      case 'float':
        return (
          <Input
            type="number"
            step="any"
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => handleFloatChange(e.target.value)}
            placeholder={placeholder || '0.0'}
            disabled={disabled}
            className={baseClassName}
            min={definition?.validation?.min}
            max={definition?.validation?.max}
          />
        );

      case 'boolean':
        return (
          <div className="flex items-center space-x-2">
            <Switch
              checked={Boolean(value)}
              onCheckedChange={handleBooleanChange}
              disabled={disabled}
              id={`switch-${parameterKey}`}
            />
            <Label
              htmlFor={`switch-${parameterKey}`}
              className="text-sm font-normal"
            >
              {Boolean(value) ? 'true' : 'false'}
            </Label>
          </div>
        );

      case 'array':
        if (Array.isArray(value)) {
          return (
            <div className="space-y-2">
              {value.map((item, index) => (
                <div key={index} className="flex items-center space-x-2">
                  <Input
                    type="text"
                    value={
                      typeof item === 'string' ? item : JSON.stringify(item)
                    }
                    onChange={(e) =>
                      handleArrayItemChange(index, e.target.value)
                    }
                    placeholder={`Item ${index + 1}`}
                    disabled={disabled}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleArrayItemRemove(index)}
                    disabled={disabled}
                    className="p-2"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleArrayItemAdd}
                disabled={disabled}
                className="w-full"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Item
              </Button>
            </div>
          );
        }
        // Fallback to JSON editor for non-array values
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Code className="h-3 w-3" />
              <span>JSON Array Editor</span>
            </div>
            <Textarea
              value={formatJsonValue(value)}
              onChange={(e) => handleJsonChange(e.target.value)}
              placeholder={placeholder || '[]'}
              disabled={disabled}
              className={cn(baseClassName, 'font-mono text-sm min-h-[100px]')}
              rows={5}
            />
          </div>
        );

      case 'object':
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Code className="h-3 w-3" />
              <span>JSON Object Editor</span>
            </div>
            <Textarea
              value={formatJsonValue(value)}
              onChange={(e) => handleJsonChange(e.target.value)}
              placeholder={placeholder || '{}'}
              disabled={disabled}
              className={cn(baseClassName, 'font-mono text-sm min-h-[120px]')}
              rows={6}
            />
          </div>
        );

      default:
        return (
          <Input
            type="text"
            value={String(value || '')}
            onChange={(e) => handleStringChange(e.target.value)}
            placeholder={placeholder || `Enter ${parameterKey}`}
            disabled={disabled}
            className={baseClassName}
          />
        );
    }
  };

  return (
    <Card className={cn('relative', className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-sm font-medium">
              {parameterKey}
              {isRequired && <span className="text-red-500 ml-1">*</span>}
            </CardTitle>
            <CardDescription className="text-xs">
              Type: {parameterType}
              {definition?.category && (
                <span className="ml-2 px-1.5 py-0.5 bg-muted rounded text-xs">
                  {definition.category}
                </span>
              )}
            </CardDescription>
          </div>
          {showRemove && onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onRemove(parameterKey)}
              disabled={disabled}
              className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {renderParameterInfo()}
        {renderInput()}
        {renderValidationMessages()}
      </CardContent>
    </Card>
  );
};

export default DynamicParameterInput;
