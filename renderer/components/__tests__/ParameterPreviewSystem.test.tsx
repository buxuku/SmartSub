/**
 * ParameterPreviewSystem Test Suite
 *
 * Comprehensive tests for the Parameter Preview System component.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  ParameterPreviewSystem,
  PreviewRequest,
} from '../ParameterPreviewSystem';
import { CustomParameterConfig } from '../../../types/provider';

// Mock Lucide React icons
jest.mock('lucide-react', () => ({
  Eye: () => <div data-testid="eye-icon">Eye</div>,
  Code: () => <div data-testid="code-icon">Code</div>,
  Send: () => <div data-testid="send-icon">Send</div>,
  CheckCircle: () => <div data-testid="check-circle-icon">CheckCircle</div>,
  AlertCircle: () => <div data-testid="alert-circle-icon">AlertCircle</div>,
  Copy: () => <div data-testid="copy-icon">Copy</div>,
  Download: () => <div data-testid="download-icon">Download</div>,
  RefreshCw: () => <div data-testid="refresh-icon">RefreshCw</div>,
  Settings: () => <div data-testid="settings-icon">Settings</div>,
  Zap: () => <div data-testid="zap-icon">Zap</div>,
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
  Button: ({ children, onClick, disabled, variant, size, ...props }: any) => (
    <button
      onClick={onClick}
      disabled={disabled}
      data-variant={variant}
      data-size={size}
      {...props}
    >
      {children}
    </button>
  ),
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

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, variant, className, ...props }: any) => (
    <span
      data-testid="badge"
      data-variant={variant}
      className={className}
      {...props}
    >
      {children}
    </span>
  ),
}));

jest.mock('@/components/ui/separator', () => ({
  Separator: (props: any) => <hr data-testid="separator" {...props} />,
}));

jest.mock('@/components/ui/alert', () => ({
  Alert: ({ children, variant, ...props }: any) => (
    <div data-testid="alert" data-variant={variant} {...props}>
      {children}
    </div>
  ),
  AlertDescription: ({ children, ...props }: any) => (
    <div data-testid="alert-description" {...props}>
      {children}
    </div>
  ),
}));

jest.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange, value, disabled, ...props }: any) => (
    <div
      data-testid="select"
      data-value={value}
      data-disabled={disabled}
      {...props}
    >
      {React.Children.map(children, (child) =>
        React.cloneElement(child, { onValueChange, value, disabled }),
      )}
    </div>
  ),
  SelectContent: ({ children, ...props }: any) => (
    <div data-testid="select-content" {...props}>
      {children}
    </div>
  ),
  SelectItem: ({ children, value, onValueChange, disabled, ...props }: any) => (
    <button
      data-testid={`select-item-${value}`}
      onClick={() => !disabled && onValueChange?.(value)}
      disabled={disabled}
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

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn().mockResolvedValue(undefined),
  },
});

// Mock URL.createObjectURL
global.URL.createObjectURL = jest.fn(() => 'mock-url');
global.URL.revokeObjectURL = jest.fn();

describe('ParameterPreviewSystem', () => {
  const mockConfig: CustomParameterConfig = {
    headerConfigs: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    bodyConfigs: {
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 1.0,
    },
  };

  const mockCallbacks = {
    onConfigChange: jest.fn(),
    onSendRequest: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Component Rendering', () => {
    it('renders without crashing', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);
      expect(screen.getByText('Parameter Preview System')).toBeInTheDocument();
    });

    it('displays main interface elements', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      expect(screen.getByText('Parameter Preview System')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Real-time preview of your parameter configuration and API request structure',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('API Endpoint')).toBeInTheDocument();
      expect(screen.getByText('Model')).toBeInTheDocument();
    });

    it('shows validation status and complexity', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      expect(screen.getByTestId('check-circle-icon')).toBeInTheDocument();
      expect(screen.getByText('Valid')).toBeInTheDocument();
      expect(screen.getByTestId('badge')).toBeInTheDocument();
    });

    it('displays metrics summary', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      expect(screen.getByText('2')).toBeInTheDocument(); // Headers count
      expect(screen.getByText('3')).toBeInTheDocument(); // Parameters count
      expect(screen.getByText('Headers')).toBeInTheDocument();
      expect(screen.getByText('Parameters')).toBeInTheDocument();
      expect(screen.getByText('Est. Tokens')).toBeInTheDocument();
      expect(screen.getByText('Est. Cost')).toBeInTheDocument();
    });
  });

  describe('Tab Navigation', () => {
    it('renders all tabs', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      expect(screen.getByTestId('tab-trigger-preview')).toBeInTheDocument();
      expect(screen.getByTestId('tab-trigger-headers')).toBeInTheDocument();
      expect(screen.getByTestId('tab-trigger-body')).toBeInTheDocument();
      expect(screen.getByTestId('tab-trigger-curl')).toBeInTheDocument();
    });

    it('switches between tabs', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      // Default tab should be preview
      expect(screen.getByTestId('tab-content-preview')).toBeInTheDocument();

      // Switch to headers tab
      fireEvent.click(screen.getByTestId('tab-trigger-headers'));
      expect(screen.getByTestId('tab-content-headers')).toBeInTheDocument();

      // Switch to body tab
      fireEvent.click(screen.getByTestId('tab-trigger-body'));
      expect(screen.getByTestId('tab-content-body')).toBeInTheDocument();

      // Switch to curl tab
      fireEvent.click(screen.getByTestId('tab-trigger-curl'));
      expect(screen.getByTestId('tab-content-curl')).toBeInTheDocument();
    });
  });

  describe('Preview Content', () => {
    it('displays complete request preview', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      expect(screen.getByText('Complete Request Preview')).toBeInTheDocument();
      expect(screen.getByText('POST')).toBeInTheDocument();
      expect(screen.getByText('Request Structure')).toBeInTheDocument();
    });

    it('shows request headers in headers tab', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      fireEvent.click(screen.getByTestId('tab-trigger-headers'));
      expect(screen.getByText('Request Headers')).toBeInTheDocument();
    });

    it('shows request body in body tab', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      fireEvent.click(screen.getByTestId('tab-trigger-body'));
      expect(screen.getByText('Request Body')).toBeInTheDocument();
    });

    it('shows curl command in curl tab', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      fireEvent.click(screen.getByTestId('tab-trigger-curl'));
      expect(screen.getByText('cURL Command')).toBeInTheDocument();
    });
  });

  describe('Configuration Controls', () => {
    it('allows endpoint selection', () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      expect(
        screen.getByTestId(
          'select-item-https://api.openai.com/v1/chat/completions',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('select-item-https://api.anthropic.com/v1/messages'),
      ).toBeInTheDocument();
    });

    it('allows model selection based on provider', () => {
      render(
        <ParameterPreviewSystem config={mockConfig} providerId="openai" />,
      );

      expect(screen.getByTestId('select-item-gpt-4')).toBeInTheDocument();
      expect(screen.getByTestId('select-item-gpt-4-turbo')).toBeInTheDocument();
      expect(
        screen.getByTestId('select-item-gpt-3.5-turbo'),
      ).toBeInTheDocument();
    });

    it('updates model options when provider changes', () => {
      render(
        <ParameterPreviewSystem config={mockConfig} providerId="claude" />,
      );

      expect(
        screen.getByTestId('select-item-claude-3-opus'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('select-item-claude-3-sonnet'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('select-item-claude-3-haiku'),
      ).toBeInTheDocument();
    });
  });

  describe('Copy Functionality', () => {
    it('copies request data to clipboard', async () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      const copyButton = screen.getByText('Copy Request');
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalled();
        expect(screen.getByText('Copied!')).toBeInTheDocument();
      });
    });

    it('copies headers to clipboard', async () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      fireEvent.click(screen.getByTestId('tab-trigger-headers'));

      const copyButton = screen.getByText('Copy Headers');
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalled();
      });
    });

    it('copies body to clipboard', async () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      fireEvent.click(screen.getByTestId('tab-trigger-body'));

      const copyButton = screen.getByText('Copy Body');
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalled();
      });
    });

    it('copies curl command to clipboard', async () => {
      render(<ParameterPreviewSystem config={mockConfig} />);

      fireEvent.click(screen.getByTestId('tab-trigger-curl'));

      const copyButton = screen.getByText('Copy cURL');
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalled();
      });
    });
  });

  describe('Download Functionality', () => {
    it('downloads request as JSON file', () => {
      const mockLink = {
        href: '',
        download: '',
        click: jest.fn(),
      };
      jest.spyOn(document, 'createElement').mockReturnValue(mockLink as any);
      jest.spyOn(document.body, 'appendChild').mockImplementation();
      jest.spyOn(document.body, 'removeChild').mockImplementation();

      render(<ParameterPreviewSystem config={mockConfig} />);

      const downloadButton = screen.getByText('Download');
      fireEvent.click(downloadButton);

      expect(mockLink.click).toHaveBeenCalled();
      expect(mockLink.download).toBe('api-request.json');
      expect(global.URL.createObjectURL).toHaveBeenCalled();
    });
  });

  describe('Send Request Functionality', () => {
    it('calls onSendRequest when send button is clicked', () => {
      render(<ParameterPreviewSystem config={mockConfig} {...mockCallbacks} />);

      const sendButton = screen.getByText('Send Request');
      fireEvent.click(sendButton);

      expect(mockCallbacks.onSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.any(String),
          method: 'POST',
          headers: expect.any(Object),
          body: expect.any(Object),
          curlCommand: expect.any(String),
        }),
      );
    });

    it('disables send button when validation fails', () => {
      const invalidConfig: CustomParameterConfig = {
        headerConfigs: {},
        bodyConfigs: {},
      };

      render(
        <ParameterPreviewSystem config={invalidConfig} {...mockCallbacks} />,
      );

      const sendButton = screen.getByText('Send Request');
      expect(sendButton).toBeDisabled();
    });
  });

  describe('Validation', () => {
    it('shows validation errors for missing API key', () => {
      const invalidConfig: CustomParameterConfig = {
        headerConfigs: {},
        bodyConfigs: { temperature: 0.7 },
      };

      render(<ParameterPreviewSystem config={invalidConfig} />);

      expect(screen.getByTestId('alert-circle-icon')).toBeInTheDocument();
      expect(screen.getByText('Invalid')).toBeInTheDocument();
      expect(
        screen.getByText(
          'API key is required (Authorization or x-api-key header)',
        ),
      ).toBeInTheDocument();
    });

    it('shows validation warnings for invalid parameters', () => {
      const configWithWarnings: CustomParameterConfig = {
        headerConfigs: { Authorization: 'Bearer test' },
        bodyConfigs: {
          temperature: 3.0, // Invalid temperature
          max_tokens: -100, // Invalid max_tokens
        },
      };

      render(
        <ParameterPreviewSystem config={configWithWarnings} model="gpt-4" />,
      );

      expect(
        screen.getByText('Temperature should be a number between 0 and 2'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Max tokens should be a positive number'),
      ).toBeInTheDocument();
    });

    it('validates successfully with correct configuration', () => {
      render(<ParameterPreviewSystem config={mockConfig} model="gpt-4" />);

      expect(screen.getByTestId('check-circle-icon')).toBeInTheDocument();
      expect(screen.getByText('Valid')).toBeInTheDocument();
    });
  });

  describe('Metrics Calculation', () => {
    it('calculates correct complexity for simple config', () => {
      const simpleConfig: CustomParameterConfig = {
        headerConfigs: { Authorization: 'Bearer test' },
        bodyConfigs: { temperature: 0.7 },
      };

      render(<ParameterPreviewSystem config={simpleConfig} />);

      expect(screen.getByText('low complexity')).toBeInTheDocument();
    });

    it('calculates correct complexity for complex config', () => {
      const complexConfig: CustomParameterConfig = {
        headerConfigs: {
          Authorization: 'Bearer test',
          'Custom-Header': 'value',
          'Another-Header': 'value',
        },
        bodyConfigs: {
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 1.0,
          frequency_penalty: 0,
          presence_penalty: 0,
          stop: ['\\n'],
          logit_bias: {},
          user: 'test-user',
          stream: false,
          n: 1,
          echo: false,
          best_of: 1,
        },
      };

      render(<ParameterPreviewSystem config={complexConfig} />);

      expect(screen.getByText('high complexity')).toBeInTheDocument();
    });
  });

  describe('Disabled State', () => {
    it('disables all interactions when disabled', () => {
      render(<ParameterPreviewSystem config={mockConfig} disabled={true} />);

      // Check that selects are disabled
      expect(screen.getAllByTestId('select')[0]).toHaveAttribute(
        'data-disabled',
        'true',
      );
      expect(screen.getAllByTestId('select')[1]).toHaveAttribute(
        'data-disabled',
        'true',
      );

      // Check that buttons are disabled
      const buttons = screen.getAllByRole('button');
      buttons.forEach((button) => {
        expect(button).toBeDisabled();
      });
    });
  });

  describe('Provider-Specific Behavior', () => {
    it('uses correct endpoint for OpenAI', () => {
      render(
        <ParameterPreviewSystem config={mockConfig} providerId="openai" />,
      );

      expect(
        screen.getByTestId(
          'select-item-https://api.openai.com/v1/chat/completions',
        ),
      ).toBeInTheDocument();
    });

    it('uses correct endpoint for Claude', () => {
      render(
        <ParameterPreviewSystem config={mockConfig} providerId="claude" />,
      );

      expect(
        screen.getByTestId('select-item-https://api.anthropic.com/v1/messages'),
      ).toBeInTheDocument();
    });

    it('shows correct models for each provider', () => {
      const { rerender } = render(
        <ParameterPreviewSystem config={mockConfig} providerId="openai" />,
      );
      expect(screen.getByTestId('select-item-gpt-4')).toBeInTheDocument();

      rerender(
        <ParameterPreviewSystem config={mockConfig} providerId="doubao" />,
      );
      expect(
        screen.getByTestId('select-item-doubao-pro-4k'),
      ).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('handles clipboard errors gracefully', async () => {
      (navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(
        new Error('Clipboard error'),
      );
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      render(<ParameterPreviewSystem config={mockConfig} />);

      const copyButton = screen.getByText('Copy Request');
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          'Failed to copy:',
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });
  });
});
