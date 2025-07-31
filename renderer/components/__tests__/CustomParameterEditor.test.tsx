/**
 * CustomParameterEditor Test Suite
 *
 * Comprehensive tests for the CustomParameterEditor component.
 */

import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomParameterEditor } from '../CustomParameterEditor';
import { useParameterConfig } from '../../hooks/useParameterConfig';
import {
  ParameterValue,
  ParameterDefinition,
  ValidationError,
  CustomParameterConfig,
} from '../../../types/provider';

// Mock the parameter hook
jest.mock('../../hooks/useParameterConfig');
const mockUseParameterConfig = useParameterConfig as jest.MockedFunction<
  typeof useParameterConfig
>;

// Mock Lucide React icons
jest.mock('lucide-react', () => ({
  Plus: () => <div data-testid="plus-icon">Plus</div>,
  Search: () => <div data-testid="search-icon">Search</div>,
  Settings: () => <div data-testid="settings-icon">Settings</div>,
  Trash2: () => <div data-testid="trash-icon">Trash2</div>,
  Copy: () => <div data-testid="copy-icon">Copy</div>,
  Download: () => <div data-testid="download-icon">Download</div>,
  Upload: () => <div data-testid="upload-icon">Upload</div>,
  RefreshCw: () => <div data-testid="refresh-icon">RefreshCw</div>,
}));

// Mock UI components
jest.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: any) => (
    <div data-testid="card" {...props}>
      {children}
    </div>
  ),
  CardContent: ({ children, ...props }: any) => (
    <div data-testid="card-content" {...props}>
      {children}
    </div>
  ),
  CardHeader: ({ children, ...props }: any) => (
    <div data-testid="card-header" {...props}>
      {children}
    </div>
  ),
  CardTitle: ({ children, ...props }: any) => (
    <div data-testid="card-title" {...props}>
      {children}
    </div>
  ),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    size,
    asChild,
    ...props
  }: any) => {
    if (asChild) {
      return (
        <span
          onClick={onClick}
          data-disabled={disabled}
          data-variant={variant}
          data-size={size}
          {...props}
        >
          {children}
        </span>
      );
    }
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        data-variant={variant}
        data-size={size}
        {...props}
      >
        {children}
      </button>
    );
  },
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input data-testid="input" {...props} />,
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value, onValueChange, ...props }: any) => (
    <div data-testid="tabs" data-value={value} {...props}>
      {React.Children.map(children, (child) =>
        React.cloneElement(child, {
          activeTab: value,
          onTabChange: onValueChange,
        }),
      )}
    </div>
  ),
  TabsContent: ({ children, value, activeTab, ...props }: any) =>
    activeTab === value ? (
      <div data-testid={`tab-content-${value}`} {...props}>
        {children}
      </div>
    ) : null,
  TabsList: ({ children, ...props }: any) => (
    <div data-testid="tabs-list" {...props}>
      {children}
    </div>
  ),
  TabsTrigger: ({ children, value, onTabChange, ...props }: any) => (
    <button
      data-testid={`tab-trigger-${value}`}
      onClick={() => onTabChange?.(value)}
      {...props}
    >
      {children}
    </button>
  ),
}));

jest.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange, value, ...props }: any) => (
    <div data-testid="select" data-value={value} {...props}>
      {React.Children.map(children, (child) =>
        React.cloneElement(child, { onValueChange, value }),
      )}
    </div>
  ),
  SelectContent: ({ children, ...props }: any) => (
    <div data-testid="select-content" {...props}>
      {children}
    </div>
  ),
  SelectItem: ({ children, value, onValueChange, ...props }: any) => (
    <button
      data-testid={`select-item-${value}`}
      onClick={() => onValueChange?.(value)}
      {...props}
    >
      {children}
    </button>
  ),
  SelectTrigger: ({ children, ...props }: any) => (
    <div data-testid="select-trigger" {...props}>
      {children}
    </div>
  ),
  SelectValue: ({ placeholder, ...props }: any) => (
    <span data-testid="select-value" {...props}>
      {placeholder}
    </span>
  ),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, variant, ...props }: any) => (
    <span data-testid="badge" data-variant={variant} {...props}>
      {children}
    </span>
  ),
}));

jest.mock('@/components/ui/separator', () => ({
  Separator: (props: any) => <hr data-testid="separator" {...props} />,
}));

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open, onOpenChange, ...props }: any) =>
    open ? (
      <div data-testid="alert-dialog" {...props}>
        {React.Children.map(children, (child) =>
          React.cloneElement(child, { onOpenChange }),
        )}
      </div>
    ) : null,
  AlertDialogAction: ({ children, onClick, ...props }: any) => (
    <button data-testid="alert-dialog-action" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children, onClick, ...props }: any) => (
    <button data-testid="alert-dialog-cancel" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  AlertDialogContent: ({ children, ...props }: any) => (
    <div data-testid="alert-dialog-content" {...props}>
      {children}
    </div>
  ),
  AlertDialogDescription: ({ children, ...props }: any) => (
    <div data-testid="alert-dialog-description" {...props}>
      {children}
    </div>
  ),
  AlertDialogFooter: ({ children, ...props }: any) => (
    <div data-testid="alert-dialog-footer" {...props}>
      {children}
    </div>
  ),
  AlertDialogHeader: ({ children, ...props }: any) => (
    <div data-testid="alert-dialog-header" {...props}>
      {children}
    </div>
  ),
  AlertDialogTitle: ({ children, ...props }: any) => (
    <div data-testid="alert-dialog-title" {...props}>
      {children}
    </div>
  ),
  AlertDialogTrigger: ({ children, ...props }: any) => (
    <div data-testid="alert-dialog-trigger" {...props}>
      {children}
    </div>
  ),
}));

// Mock DynamicParameterInput
jest.mock('../DynamicParameterInput', () => ({
  DynamicParameterInput: ({
    parameterKey,
    value,
    onChange,
    onRemove,
    showRemove,
    disabled,
  }: any) => (
    <div data-testid={`dynamic-parameter-input-${parameterKey}`}>
      <input
        data-testid={`parameter-input-${parameterKey}`}
        value={typeof value === 'string' ? value : JSON.stringify(value)}
        onChange={(e) => {
          let newValue: ParameterValue = e.target.value;
          try {
            newValue = JSON.parse(e.target.value);
          } catch {
            // Keep as string if not valid JSON
          }
          onChange(parameterKey, newValue);
        }}
        disabled={disabled}
      />
      {showRemove && (
        <button
          data-testid={`remove-parameter-${parameterKey}`}
          onClick={() => onRemove(parameterKey)}
          disabled={disabled}
        >
          Remove
        </button>
      )}
    </div>
  ),
}));

describe('CustomParameterEditor', () => {
  const mockParameterConfig = {
    parameters: {
      Authorization: 'Bearer token123',
      'Content-Type': 'application/json',
      temperature: 0.7,
      max_tokens: 1000,
      enable_thinking: false,
    },
    definitions: {
      Authorization: {
        key: 'Authorization',
        type: 'string' as const,
        category: 'header' as const,
        required: true,
        description: 'API authorization header',
        providerSupport: ['openai'],
      },
      'Content-Type': {
        key: 'Content-Type',
        type: 'string' as const,
        category: 'header' as const,
        required: true,
        description: 'Content type header',
        providerSupport: ['openai'],
      },
      temperature: {
        key: 'temperature',
        type: 'number' as const,
        category: 'core' as const,
        required: false,
        description: 'Sampling temperature',
        providerSupport: ['openai'],
      },
      max_tokens: {
        key: 'max_tokens',
        type: 'number' as const,
        category: 'core' as const,
        required: false,
        description: 'Maximum tokens to generate',
        providerSupport: ['openai'],
      },
      enable_thinking: {
        key: 'enable_thinking',
        type: 'boolean' as const,
        category: 'core' as const,
        required: false,
        description: 'Enable thinking mode',
        providerSupport: ['openai'],
      },
    },
    errors: [] as ValidationError[],
    loadParameters: jest.fn(),
    saveParameters: jest.fn(),
    addParameter: jest.fn(),
    updateParameter: jest.fn(),
    removeParameter: jest.fn(),
    validateAll: jest.fn(),
    exportConfig: jest.fn(),
    importConfig: jest.fn(),
    applyTemplate: jest.fn(),
    getTemplates: jest.fn(() => [
      { name: 'OpenAI Default', description: 'Default OpenAI parameters' },
      { name: 'Claude Optimized', description: 'Optimized for Claude models' },
    ]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseParameterConfig.mockReturnValue(mockParameterConfig);
  });

  describe('Component Rendering', () => {
    it('renders without crashing', () => {
      render(<CustomParameterEditor providerId="openai" />);
      expect(screen.getByText('Custom Parameters')).toBeInTheDocument();
    });

    it('displays provider configuration interface', () => {
      render(<CustomParameterEditor providerId="openai" />);

      expect(screen.getByText('Custom Parameters')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Configure custom headers and body parameters for this provider',
        ),
      ).toBeInTheDocument();
    });

    it('shows parameter tabs with counts', () => {
      render(<CustomParameterEditor providerId="openai" />);

      expect(screen.getByTestId('tab-trigger-headers')).toBeInTheDocument();
      expect(screen.getByTestId('tab-trigger-body')).toBeInTheDocument();

      // Should show badge with counts
      const badges = screen.getAllByTestId('badge');
      expect(badges.length).toBeGreaterThanOrEqual(2);
    });

    it('displays action buttons', () => {
      render(<CustomParameterEditor providerId="openai" />);

      expect(screen.getByText('Export')).toBeInTheDocument();
      expect(screen.getByText('Import')).toBeInTheDocument();
      expect(screen.getByText('Refresh')).toBeInTheDocument();
      expect(screen.getByText('Add Parameter')).toBeInTheDocument();
    });
  });

  describe('Parameter Management', () => {
    it('displays header parameters in headers tab', () => {
      render(<CustomParameterEditor providerId="openai" />);

      // Should be on headers tab by default
      expect(
        screen.getByTestId('dynamic-parameter-input-Authorization'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('dynamic-parameter-input-Content-Type'),
      ).toBeInTheDocument();
    });

    it('displays body parameters in body tab', () => {
      render(<CustomParameterEditor providerId="openai" />);

      // Switch to body tab
      fireEvent.click(screen.getByTestId('tab-trigger-body'));

      expect(
        screen.getByTestId('dynamic-parameter-input-temperature'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('dynamic-parameter-input-max_tokens'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('dynamic-parameter-input-enable_thinking'),
      ).toBeInTheDocument();
    });

    it('handles parameter value changes', () => {
      render(<CustomParameterEditor providerId="openai" />);

      const temperatureInput = screen.getByTestId(
        'parameter-input-temperature',
      );
      fireEvent.change(temperatureInput, { target: { value: '0.9' } });

      expect(mockParameterConfig.updateParameter).toHaveBeenCalledWith(
        'temperature',
        0.9,
      );
    });

    it('handles parameter removal', () => {
      render(<CustomParameterEditor providerId="openai" />);

      // Switch to body tab to see removable parameters
      fireEvent.click(screen.getByTestId('tab-trigger-body'));

      const removeButton = screen.getByTestId('remove-parameter-temperature');
      fireEvent.click(removeButton);

      expect(mockParameterConfig.removeParameter).toHaveBeenCalledWith(
        'temperature',
      );
    });
  });

  describe('Add Parameter Dialog', () => {
    it('opens add parameter dialog', () => {
      render(<CustomParameterEditor providerId="openai" />);

      fireEvent.click(screen.getByText('Add Parameter'));

      expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
      expect(screen.getByText('Add New Parameter')).toBeInTheDocument();
    });

    it('allows parameter configuration in dialog', async () => {
      render(<CustomParameterEditor providerId="openai" />);

      fireEvent.click(screen.getByText('Add Parameter'));

      // Fill in parameter details
      const keyInput = screen.getByDisplayValue('');
      fireEvent.change(keyInput, { target: { value: 'custom_param' } });

      // Select category and type through select components
      const categorySelect = screen.getByTestId('select-item-body');
      fireEvent.click(categorySelect);

      const typeSelect = screen.getByTestId('select-item-number');
      fireEvent.click(typeSelect);

      // Add parameter
      fireEvent.click(screen.getByTestId('alert-dialog-action'));

      await waitFor(() => {
        expect(mockParameterConfig.addParameter).toHaveBeenCalledWith(
          'custom_param',
          '',
          expect.objectContaining({
            key: 'custom_param',
            type: 'number',
            category: 'core',
            required: false,
          }),
        );
      });
    });

    it('cancels parameter addition', () => {
      render(<CustomParameterEditor providerId="openai" />);

      fireEvent.click(screen.getByText('Add Parameter'));
      fireEvent.click(screen.getByTestId('alert-dialog-cancel'));

      expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
    });
  });

  describe('Search Functionality', () => {
    it('filters parameters by search query', () => {
      render(<CustomParameterEditor providerId="openai" />);

      const searchInput = screen.getByPlaceholderText('Search parameters...');
      fireEvent.change(searchInput, { target: { value: 'auth' } });

      // Should filter to only show Authorization parameter
      expect(
        screen.getByTestId('dynamic-parameter-input-Authorization'),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId('dynamic-parameter-input-Content-Type'),
      ).not.toBeInTheDocument();
    });

    it('shows no results message when search has no matches', () => {
      render(<CustomParameterEditor providerId="openai" />);

      const searchInput = screen.getByPlaceholderText('Search parameters...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

      expect(
        screen.getByText('No headers match your search.'),
      ).toBeInTheDocument();
    });
  });

  describe('Template Management', () => {
    it('shows available templates', () => {
      render(<CustomParameterEditor providerId="openai" />);

      expect(
        screen.getByTestId('select-item-OpenAI Default'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('select-item-Claude Optimized'),
      ).toBeInTheDocument();
    });

    it('applies selected template', () => {
      render(<CustomParameterEditor providerId="openai" />);

      fireEvent.click(screen.getByTestId('select-item-OpenAI Default'));

      expect(mockParameterConfig.applyTemplate).toHaveBeenCalledWith(
        'OpenAI Default',
      );
    });
  });

  describe('Import/Export', () => {
    it('handles configuration export', async () => {
      // Mock URL.createObjectURL and related DOM APIs
      global.URL.createObjectURL = jest.fn(() => 'mock-url');
      global.URL.revokeObjectURL = jest.fn();

      const mockLink = {
        href: '',
        download: '',
        click: jest.fn(),
      };
      jest.spyOn(document, 'createElement').mockReturnValue(mockLink as any);
      jest.spyOn(document.body, 'appendChild').mockImplementation();
      jest.spyOn(document.body, 'removeChild').mockImplementation();

      mockParameterConfig.exportConfig.mockResolvedValue({
        headerConfigs: { Authorization: 'Bearer token123' },
        bodyConfigs: { temperature: 0.7 },
      });

      render(<CustomParameterEditor providerId="openai" />);

      fireEvent.click(screen.getByText('Export'));

      await waitFor(() => {
        expect(mockParameterConfig.exportConfig).toHaveBeenCalled();
        expect(mockLink.click).toHaveBeenCalled();
      });
    });

    it('handles configuration import', async () => {
      const file = new File(['{"headerConfigs": {}}'], 'config.json', {
        type: 'application/json',
      });

      render(<CustomParameterEditor providerId="openai" />);

      const fileInput = screen.getByDisplayValue('');
      fireEvent.change(fileInput, { target: { files: [file] } });

      // Wait for file reader to process
      await waitFor(() => {
        expect(mockParameterConfig.importConfig).toHaveBeenCalled();
      });
    });
  });

  describe('Configuration Changes', () => {
    it('calls onConfigChange when parameters are modified', () => {
      const mockOnConfigChange = jest.fn();
      render(
        <CustomParameterEditor
          providerId="openai"
          onConfigChange={mockOnConfigChange}
        />,
      );

      const temperatureInput = screen.getByTestId(
        'parameter-input-temperature',
      );
      fireEvent.change(temperatureInput, { target: { value: '0.9' } });

      expect(mockOnConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({
          headerConfigs: expect.any(Object),
          bodyConfigs: expect.any(Object),
        }),
      );
    });

    it('calls onSave when save button is clicked', () => {
      const mockOnSave = jest.fn();
      render(<CustomParameterEditor providerId="openai" onSave={mockOnSave} />);

      fireEvent.click(screen.getByText('Save Changes'));

      expect(mockOnSave).toHaveBeenCalled();
    });
  });

  describe('Disabled State', () => {
    it('disables all interactions when disabled prop is true', () => {
      render(<CustomParameterEditor providerId="openai" disabled={true} />);

      expect(screen.getByText('Add Parameter')).toBeDisabled();
      expect(screen.getByText('Export')).toBeDisabled();
      expect(screen.getByText('Refresh')).toBeDisabled();
      expect(
        screen.getByPlaceholderText('Search parameters...'),
      ).toBeDisabled();
    });
  });

  describe('Parameter Duplication', () => {
    it('duplicates existing parameters', () => {
      render(<CustomParameterEditor providerId="openai" />);

      // Switch to body tab to see duplicate buttons
      fireEvent.click(screen.getByTestId('tab-trigger-body'));

      const duplicateButton = screen.getByText('Duplicate');
      fireEvent.click(duplicateButton);

      expect(mockParameterConfig.addParameter).toHaveBeenCalledWith(
        expect.stringContaining('_copy'),
        expect.any(String),
        expect.objectContaining({
          description: expect.stringContaining('Copy of'),
        }),
      );
    });
  });

  describe('Configuration Summary', () => {
    it('displays configuration summary', () => {
      render(<CustomParameterEditor providerId="openai" />);

      expect(screen.getByText('Configuration Summary')).toBeInTheDocument();
      expect(screen.getByText(/Total Parameters:/)).toBeInTheDocument();
      expect(screen.getByText(/Headers:/)).toBeInTheDocument();
      expect(screen.getByText(/Body Parameters:/)).toBeInTheDocument();
      expect(screen.getByText(/Validation Errors:/)).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('displays validation errors', () => {
      const configWithErrors = {
        ...mockParameterConfig,
        errors: [
          {
            key: 'temperature',
            type: 'range' as const,
            message: 'Temperature must be between 0 and 2',
            suggestion: 'Use a value between 0 and 2',
          },
        ],
      };

      mockUseParameterConfig.mockReturnValue(configWithErrors);

      render(<CustomParameterEditor providerId="openai" />);

      expect(screen.getByText('1')).toBeInTheDocument(); // Error count in summary
    });
  });
});
