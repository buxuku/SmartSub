/**
 * DynamicParameterInput Component Tests
 *
 * Tests for different parameter types, validation, and user interactions.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  DynamicParameterInput,
  DynamicParameterInputProps,
} from '../DynamicParameterInput';
import { ParameterDefinition, ValidationError } from '../../../types/provider';

// Mock the utils import
jest.mock('lib/utils', () => ({
  cn: (...classes: any[]) => classes.filter(Boolean).join(' '),
}));

// Mock Lucide React icons
jest.mock('lucide-react', () => ({
  Trash2: () => <div data-testid="trash-icon" />,
  Plus: () => <div data-testid="plus-icon" />,
  AlertCircle: () => <div data-testid="alert-icon" />,
  CheckCircle2: () => <div data-testid="check-icon" />,
  Info: () => <div data-testid="info-icon" />,
  Code: () => <div data-testid="code-icon" />,
}));

describe('DynamicParameterInput', () => {
  const defaultProps: DynamicParameterInputProps = {
    parameterKey: 'testParam',
    value: '',
    onChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('String Parameter Type', () => {
    it('renders string input correctly', () => {
      const definition: ParameterDefinition = {
        key: 'testParam',
        type: 'string',
        category: 'core',
        required: true,
        description: 'Test string parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          definition={definition}
          value="test value"
        />,
      );

      expect(screen.getByDisplayValue('test value')).toBeInTheDocument();
      expect(screen.getByText('testParam')).toBeInTheDocument();
      expect(screen.getByText('Type: string')).toBeInTheDocument();
      expect(screen.getByText('Test string parameter')).toBeInTheDocument();
    });

    it('handles string input changes', () => {
      const onChange = jest.fn();
      const definition: ParameterDefinition = {
        key: 'testParam',
        type: 'string',
        category: 'core',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          definition={definition}
          onChange={onChange}
        />,
      );

      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'new value' } });

      expect(onChange).toHaveBeenCalledWith('testParam', 'new value');
    });
  });

  describe('Integer Parameter Type', () => {
    it('renders integer input correctly', () => {
      const definition: ParameterDefinition = {
        key: 'integerParam',
        type: 'integer',
        category: 'performance',
        required: true,
        description: 'Test integer parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="integerParam"
          definition={definition}
          value={42}
        />,
      );

      expect(screen.getByDisplayValue('42')).toBeInTheDocument();
      expect(screen.getByText('Type: integer')).toBeInTheDocument();
    });

    it('handles integer input changes', () => {
      const onChange = jest.fn();
      const definition: ParameterDefinition = {
        key: 'integerParam',
        type: 'integer',
        category: 'performance',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="numberParam"
          definition={definition}
          onChange={onChange}
        />,
      );

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '123' } });

      expect(onChange).toHaveBeenCalledWith('numberParam', 123);
    });

    it('handles invalid number input', () => {
      const onChange = jest.fn();
      const definition: ParameterDefinition = {
        key: 'numberParam',
        type: 'number',
        category: 'performance',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="numberParam"
          definition={definition}
          onChange={onChange}
        />,
      );

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: 'invalid' } });

      expect(onChange).toHaveBeenCalledWith('numberParam', 0);
    });
  });

  describe('Boolean Parameter Type', () => {
    it('renders boolean switch correctly', () => {
      const definition: ParameterDefinition = {
        key: 'boolParam',
        type: 'boolean',
        category: 'behavior',
        required: false,
        description: 'Test boolean parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="boolParam"
          definition={definition}
          value={true}
        />,
      );

      expect(screen.getByText('Type: boolean')).toBeInTheDocument();
      expect(screen.getByText('Enabled')).toBeInTheDocument();
      expect(screen.getByRole('switch')).toBeChecked();
    });

    it('handles boolean switch changes', () => {
      const onChange = jest.fn();
      const definition: ParameterDefinition = {
        key: 'boolParam',
        type: 'boolean',
        category: 'behavior',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="boolParam"
          definition={definition}
          onChange={onChange}
          value={false}
        />,
      );

      const switchElement = screen.getByRole('switch');
      fireEvent.click(switchElement);

      expect(onChange).toHaveBeenCalledWith('boolParam', true);
    });
  });

  describe('Array Parameter Type', () => {
    it('renders array editor correctly', () => {
      const definition: ParameterDefinition = {
        key: 'arrayParam',
        type: 'array',
        category: 'core',
        required: false,
        description: 'Test array parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="arrayParam"
          definition={definition}
          value={['item1', 'item2']}
        />,
      );

      expect(screen.getByText('Type: array')).toBeInTheDocument();
      expect(screen.getByDisplayValue('item1')).toBeInTheDocument();
      expect(screen.getByDisplayValue('item2')).toBeInTheDocument();
      expect(screen.getByText('Add Item')).toBeInTheDocument();
    });

    it('handles adding array items', () => {
      const onChange = jest.fn();
      const definition: ParameterDefinition = {
        key: 'arrayParam',
        type: 'array',
        category: 'core',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="arrayParam"
          definition={definition}
          onChange={onChange}
          value={['item1']}
        />,
      );

      const addButton = screen.getByText('Add Item');
      fireEvent.click(addButton);

      expect(onChange).toHaveBeenCalledWith('arrayParam', ['item1', '']);
    });

    it('handles removing array items', () => {
      const onChange = jest.fn();
      const definition: ParameterDefinition = {
        key: 'arrayParam',
        type: 'array',
        category: 'core',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="arrayParam"
          definition={definition}
          onChange={onChange}
          value={['item1', 'item2']}
        />,
      );

      const removeButtons = screen.getAllByTestId('trash-icon');
      fireEvent.click(removeButtons[0]);

      expect(onChange).toHaveBeenCalledWith('arrayParam', ['item2']);
    });
  });

  describe('Object Parameter Type', () => {
    it('renders object JSON editor correctly', () => {
      const definition: ParameterDefinition = {
        key: 'objectParam',
        type: 'object',
        category: 'core',
        required: false,
        description: 'Test object parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="objectParam"
          definition={definition}
          value={{ key: 'value' }}
        />,
      );

      expect(screen.getByText('Type: object')).toBeInTheDocument();
      expect(screen.getByText('JSON Object Editor')).toBeInTheDocument();
      expect(
        screen.getByDisplayValue(JSON.stringify({ key: 'value' }, null, 2)),
      ).toBeInTheDocument();
    });

    it('handles valid JSON input for objects', async () => {
      const onChange = jest.fn();
      const definition: ParameterDefinition = {
        key: 'objectParam',
        type: 'object',
        category: 'core',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="objectParam"
          definition={definition}
          onChange={onChange}
          value={{}}
        />,
      );

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, {
        target: { value: '{"newKey": "newValue"}' },
      });

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith('objectParam', {
          newKey: 'newValue',
        });
      });
    });

    it('handles invalid JSON input gracefully', async () => {
      const onChange = jest.fn();
      const definition: ParameterDefinition = {
        key: 'objectParam',
        type: 'object',
        category: 'core',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="objectParam"
          definition={definition}
          onChange={onChange}
          value={{}}
        />,
      );

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: '{"invalid": json}' } });

      await waitFor(() => {
        expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
      });

      // Should not call onChange with invalid JSON
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('Validation and Error Handling', () => {
    it('displays validation errors', () => {
      const errors: ValidationError[] = [
        {
          key: 'testParam',
          type: 'range',
          message: 'Value out of range',
          suggestion: 'Use a value between 1 and 10',
        },
      ];

      render(<DynamicParameterInput {...defaultProps} errors={errors} />);

      expect(screen.getByText('Value out of range')).toBeInTheDocument();
      expect(
        screen.getByText('Use a value between 1 and 10'),
      ).toBeInTheDocument();
    });

    it('shows required field indicator', () => {
      const definition: ParameterDefinition = {
        key: 'testParam',
        type: 'string',
        category: 'core',
        required: true,
        description: 'Required parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput {...defaultProps} definition={definition} />,
      );

      expect(screen.getByText('*')).toBeInTheDocument();
    });

    it('shows valid state when no errors', () => {
      render(<DynamicParameterInput {...defaultProps} value="valid value" />);

      expect(screen.getByText('Valid')).toBeInTheDocument();
      expect(screen.getByTestId('check-icon')).toBeInTheDocument();
    });
  });

  describe('Remove Functionality', () => {
    it('shows remove button when showRemove is true', () => {
      const onRemove = jest.fn();

      render(
        <DynamicParameterInput
          {...defaultProps}
          showRemove={true}
          onRemove={onRemove}
        />,
      );

      expect(screen.getByTestId('trash-icon')).toBeInTheDocument();
    });

    it('calls onRemove when remove button is clicked', () => {
      const onRemove = jest.fn();

      render(
        <DynamicParameterInput
          {...defaultProps}
          showRemove={true}
          onRemove={onRemove}
        />,
      );

      const removeButton = screen.getByRole('button');
      fireEvent.click(removeButton);

      expect(onRemove).toHaveBeenCalledWith('testParam');
    });

    it('hides remove button when showRemove is false', () => {
      render(<DynamicParameterInput {...defaultProps} showRemove={false} />);

      expect(screen.queryByTestId('trash-icon')).not.toBeInTheDocument();
    });
  });

  describe('Disabled State', () => {
    it('disables input when disabled prop is true', () => {
      render(<DynamicParameterInput {...defaultProps} disabled={true} />);

      const input = screen.getByRole('textbox');
      expect(input).toBeDisabled();
    });

    it('disables array operations when disabled', () => {
      const definition: ParameterDefinition = {
        key: 'arrayParam',
        type: 'array',
        category: 'core',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput
          {...defaultProps}
          parameterKey="arrayParam"
          definition={definition}
          value={['item1']}
          disabled={true}
        />,
      );

      const addButton = screen.getByText('Add Item');
      expect(addButton).toBeDisabled();
    });
  });

  describe('Parameter Categories', () => {
    it('displays parameter category badge', () => {
      const definition: ParameterDefinition = {
        key: 'testParam',
        type: 'string',
        category: 'performance',
        required: false,
        description: 'Test parameter',
        providerSupport: ['openai'],
      };

      render(
        <DynamicParameterInput {...defaultProps} definition={definition} />,
      );

      expect(screen.getByText('performance')).toBeInTheDocument();
    });
  });
});
