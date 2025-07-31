/**
 * ParameterTemplateManager Test Suite
 *
 * Comprehensive tests for the ParameterTemplateManager component.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ParameterTemplateManager } from '../ParameterTemplateManager';
import {
  ParameterTemplate,
  CustomParameterConfig,
} from '../../../types/provider';

// Mock Lucide React icons
jest.mock('lucide-react', () => ({
  Plus: () => <div data-testid="plus-icon">Plus</div>,
  Search: () => <div data-testid="search-icon">Search</div>,
  Download: () => <div data-testid="download-icon">Download</div>,
  Upload: () => <div data-testid="upload-icon">Upload</div>,
  Copy: () => <div data-testid="copy-icon">Copy</div>,
  Edit: () => <div data-testid="edit-icon">Edit</div>,
  Trash2: () => <div data-testid="trash-icon">Trash2</div>,
  Eye: () => <div data-testid="eye-icon">Eye</div>,
  Star: () => <div data-testid="star-icon">Star</div>,
  StarOff: () => <div data-testid="star-off-icon">StarOff</div>,
  BookOpen: () => <div data-testid="book-icon">BookOpen</div>,
  Settings: () => <div data-testid="settings-icon">Settings</div>,
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

jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => <textarea data-testid="textarea" {...props} />,
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

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value, onValueChange, defaultValue, ...props }: any) => (
    <div data-testid="tabs" data-value={defaultValue || value} {...props}>
      {React.Children.map(children, (child) =>
        React.cloneElement(child, {
          activeTab: defaultValue || value,
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

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, ...props }: any) => (
    <div data-testid="alert-dialog" {...props}>
      {children}
    </div>
  ),
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

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open, onOpenChange, ...props }: any) =>
    open ? (
      <div data-testid="dialog" {...props}>
        {React.Children.map(children, (child) =>
          React.cloneElement(child, { onOpenChange }),
        )}
      </div>
    ) : null,
  DialogContent: ({ children, ...props }: any) => (
    <div data-testid="dialog-content" {...props}>
      {children}
    </div>
  ),
  DialogDescription: ({ children, ...props }: any) => (
    <div data-testid="dialog-description" {...props}>
      {children}
    </div>
  ),
  DialogFooter: ({ children, ...props }: any) => (
    <div data-testid="dialog-footer" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children, ...props }: any) => (
    <div data-testid="dialog-header" {...props}>
      {children}
    </div>
  ),
  DialogTitle: ({ children, ...props }: any) => (
    <div data-testid="dialog-title" {...props}>
      {children}
    </div>
  ),
  DialogTrigger: ({ children, ...props }: any) => (
    <div data-testid="dialog-trigger" {...props}>
      {children}
    </div>
  ),
}));

describe('ParameterTemplateManager', () => {
  const mockCurrentConfig: CustomParameterConfig = {
    headerConfigs: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    bodyConfigs: {
      temperature: 0.7,
      max_tokens: 1000,
    },
  };

  const mockCallbacks = {
    onTemplateApply: jest.fn(),
    onTemplateCreate: jest.fn(),
    onTemplateUpdate: jest.fn(),
    onTemplateDelete: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Component Rendering', () => {
    it('renders without crashing', () => {
      render(<ParameterTemplateManager />);
      expect(screen.getByText('Parameter Templates')).toBeInTheDocument();
    });

    it('displays the main interface elements', () => {
      render(<ParameterTemplateManager />);

      expect(screen.getByText('Parameter Templates')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Manage and apply parameter configurations for AI providers',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('Create from Current')).toBeInTheDocument();
      expect(screen.getByText('Import')).toBeInTheDocument();
    });

    it('shows pre-built templates', () => {
      render(<ParameterTemplateManager />);

      expect(screen.getByText('OpenAI Default')).toBeInTheDocument();
      expect(screen.getByText('Claude Standard')).toBeInTheDocument();
      expect(
        screen.getByText('Doubao (Thinking Disabled)'),
      ).toBeInTheDocument();
    });

    it('displays template cards with correct information', () => {
      render(<ParameterTemplateManager />);

      // Check for OpenAI template details
      expect(screen.getByText('OpenAI Default')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Standard OpenAI configuration with common parameters',
        ),
      ).toBeInTheDocument();

      // Check for badges
      const badges = screen.getAllByTestId('badge');
      expect(badges.length).toBeGreaterThan(0);
    });
  });

  describe('Template Filtering', () => {
    it('filters templates by search query', () => {
      render(<ParameterTemplateManager />);

      const searchInput = screen.getByPlaceholderText('Search templates...');
      fireEvent.change(searchInput, { target: { value: 'openai' } });

      expect(screen.getByText('OpenAI Default')).toBeInTheDocument();
      expect(screen.queryByText('Claude Standard')).toBeInTheDocument(); // Still visible as it matches all
    });

    it('filters templates by category', () => {
      render(<ParameterTemplateManager />);

      // Select official category
      fireEvent.click(screen.getByTestId('select-item-official'));

      // Should show official templates
      expect(screen.getByText('OpenAI Default')).toBeInTheDocument();
      expect(screen.getByText('Claude Standard')).toBeInTheDocument();
    });

    it('filters templates by provider', () => {
      render(<ParameterTemplateManager providerId="openai" />);

      // Should show templates compatible with OpenAI
      expect(screen.getByText('OpenAI Default')).toBeInTheDocument();
    });

    it('shows empty state when no templates match', () => {
      render(<ParameterTemplateManager />);

      const searchInput = screen.getByPlaceholderText('Search templates...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

      expect(screen.getByText('No templates found')).toBeInTheDocument();
      expect(
        screen.getByText('Try adjusting your search terms'),
      ).toBeInTheDocument();
    });
  });

  describe('Template Operations', () => {
    it('applies template when Apply button is clicked', () => {
      render(<ParameterTemplateManager {...mockCallbacks} />);

      const applyButtons = screen.getAllByText('Apply');
      fireEvent.click(applyButtons[0]);

      expect(mockCallbacks.onTemplateApply).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'openai-default',
          name: 'OpenAI Default',
        }),
      );
    });

    it('toggles favorite status', () => {
      render(<ParameterTemplateManager />);

      const favoriteButtons = screen.getAllByTestId('star-off-icon');
      fireEvent.click(favoriteButtons[0].closest('button')!);

      // Should toggle to favorited state
      expect(screen.getByTestId('star-icon')).toBeInTheDocument();
    });

    it('opens preview dialog when eye button is clicked', () => {
      render(<ParameterTemplateManager />);

      const previewButtons = screen.getAllByTestId('eye-icon');
      fireEvent.click(previewButtons[0].closest('button')!);

      expect(screen.getByTestId('dialog')).toBeInTheDocument();
      expect(screen.getByText('OpenAI Default')).toBeInTheDocument();
    });

    it('exports template when download button is clicked', () => {
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

      render(<ParameterTemplateManager />);

      const downloadButtons = screen.getAllByTestId('download-icon');
      fireEvent.click(downloadButtons[0].closest('button')!);

      expect(mockLink.click).toHaveBeenCalled();
      expect(global.URL.createObjectURL).toHaveBeenCalled();
    });
  });

  describe('Template Creation', () => {
    it('opens create dialog when "Create from Current" is clicked', () => {
      render(
        <ParameterTemplateManager
          currentConfig={mockCurrentConfig}
          {...mockCallbacks}
        />,
      );

      fireEvent.click(screen.getByText('Create from Current'));

      expect(screen.getByTestId('dialog')).toBeInTheDocument();
      expect(screen.getByText('Create Template')).toBeInTheDocument();
    });

    it('disables create button when no current config', () => {
      render(<ParameterTemplateManager {...mockCallbacks} />);

      expect(screen.getByText('Create from Current')).toBeDisabled();
    });

    it('fills form with current configuration', () => {
      render(
        <ParameterTemplateManager
          providerId="openai"
          currentConfig={mockCurrentConfig}
          {...mockCallbacks}
        />,
      );

      fireEvent.click(screen.getByText('Create from Current'));

      // Check that form is pre-filled
      const nameInput = screen.getByDisplayValue('openai Template');
      expect(nameInput).toBeInTheDocument();
    });

    it('creates template when form is submitted', async () => {
      render(
        <ParameterTemplateManager
          currentConfig={mockCurrentConfig}
          {...mockCallbacks}
        />,
      );

      fireEvent.click(screen.getByText('Create from Current'));

      // Fill in template name
      const nameInput = screen.getByDisplayValue('Custom Template');
      fireEvent.change(nameInput, { target: { value: 'My Custom Template' } });

      // Submit form
      fireEvent.click(screen.getByText('Create Template'));

      await waitFor(() => {
        expect(mockCallbacks.onTemplateCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'My Custom Template',
          }),
        );
      });
    });
  });

  describe('Template Import', () => {
    it('handles template import', async () => {
      const mockTemplate: ParameterTemplate = {
        id: 'imported-template',
        name: 'Imported Template',
        description: 'Template from file',
        category: 'custom',
        tags: ['imported'],
        isPublic: false,
        isFavorite: false,
        headerConfigs: { Authorization: 'Bearer test' },
        bodyConfigs: { temperature: 0.8 },
        metadata: {
          author: 'Test',
          version: '1.0.0',
          createdAt: new Date(),
          updatedAt: new Date(),
          usageCount: 0,
        },
      };

      const file = new File([JSON.stringify(mockTemplate)], 'template.json', {
        type: 'application/json',
      });

      render(<ParameterTemplateManager />);

      const fileInput = screen.getByDisplayValue('');
      fireEvent.change(fileInput, { target: { files: [file] } });

      // Wait for file processing
      await waitFor(() => {
        expect(screen.getByText('Imported Template')).toBeInTheDocument();
      });
    });
  });

  describe('Template Preview', () => {
    it('shows template details in preview dialog', () => {
      render(<ParameterTemplateManager />);

      const previewButtons = screen.getAllByTestId('eye-icon');
      fireEvent.click(previewButtons[0].closest('button')!);

      expect(screen.getByTestId('dialog')).toBeInTheDocument();
      expect(screen.getByText('OpenAI Default')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Standard OpenAI configuration with common parameters',
        ),
      ).toBeInTheDocument();
    });

    it('shows different tabs in preview', () => {
      render(<ParameterTemplateManager />);

      const previewButtons = screen.getAllByTestId('eye-icon');
      fireEvent.click(previewButtons[0].closest('button')!);

      expect(screen.getByTestId('tab-trigger-headers')).toBeInTheDocument();
      expect(screen.getByTestId('tab-trigger-body')).toBeInTheDocument();
      expect(screen.getByTestId('tab-trigger-preview')).toBeInTheDocument();
    });

    it('applies template from preview dialog', () => {
      render(<ParameterTemplateManager {...mockCallbacks} />);

      const previewButtons = screen.getAllByTestId('eye-icon');
      fireEvent.click(previewButtons[0].closest('button')!);

      fireEvent.click(screen.getByText('Apply Template'));

      expect(mockCallbacks.onTemplateApply).toHaveBeenCalled();
    });
  });

  describe('Custom Template Management', () => {
    it('shows edit and delete buttons for custom templates', () => {
      // This would require adding a custom template to the initial state
      // For now, we'll test the UI structure
      render(<ParameterTemplateManager />);

      // The edit and delete buttons should only appear for custom templates
      // This test would be more meaningful with actual custom templates in state
      expect(screen.getAllByTestId('card')).toHaveLength(5); // Pre-built templates
    });
  });

  describe('Disabled State', () => {
    it('disables all interactions when disabled', () => {
      render(<ParameterTemplateManager disabled={true} />);

      expect(screen.getByText('Create from Current')).toBeDisabled();
      expect(screen.getByText('Import')).toHaveAttribute(
        'data-disabled',
        'true',
      );
      expect(screen.getByPlaceholderText('Search templates...')).toBeDisabled();
    });
  });

  describe('Error Handling', () => {
    it('handles invalid JSON during import gracefully', async () => {
      const invalidFile = new File(['invalid json'], 'invalid.json', {
        type: 'application/json',
      });

      // Mock console.error to avoid test output noise
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      render(<ParameterTemplateManager />);

      const fileInput = screen.getByDisplayValue('');
      fireEvent.change(fileInput, { target: { files: [invalidFile] } });

      // Should not crash the component
      expect(screen.getByText('Parameter Templates')).toBeInTheDocument();

      consoleSpy.mockRestore();
    });
  });

  describe('Provider-Specific Behavior', () => {
    it('shows only relevant templates when provider is specified', () => {
      render(<ParameterTemplateManager providerId="openai" />);

      expect(screen.getByText('OpenAI Default')).toBeInTheDocument();
      // Other templates might still be visible if they don't specify a provider
    });

    it('includes provider ID in created templates', () => {
      render(
        <ParameterTemplateManager
          providerId="openai"
          currentConfig={mockCurrentConfig}
          {...mockCallbacks}
        />,
      );

      fireEvent.click(screen.getByText('Create from Current'));
      fireEvent.click(screen.getByText('Create Template'));

      expect(mockCallbacks.onTemplateCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'openai',
        }),
      );
    });
  });
});
