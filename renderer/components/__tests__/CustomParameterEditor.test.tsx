import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import { CustomParameterEditor } from '../CustomParameterEditor';
import { useParameterConfig } from '../../hooks/useParameterConfig';
import type {
  CustomParameterConfig,
  ParameterValue,
} from '../../../types/provider';

jest.mock('../../hooks/useParameterConfig');
const mockUseParameterConfig = useParameterConfig as jest.MockedFunction<
  typeof useParameterConfig
>;

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const strings: Record<string, string> = {
        'tabs.headers': '请求头',
        'tabs.bodyParameters': '请求体参数',
        'more.label': '更多',
        'more.import': '导入 JSON',
        'more.export': '导出 JSON',
        'more.refresh': '从磁盘刷新',
        'more.search': '搜索参数',
        'addDialog.title': '添加新参数',
        'table.keyColumn': '参数名',
        'table.valueColumn': '值',
        'table.keyPlaceholder': '例如 temperature',
        'table.valuePlaceholder': '例如 0.3',
        'table.addButton': '添加',
        'table.addHint':
          '在下方「新参数」行填写参数名、类型和值，点击「添加」或按 Enter 可连续添加多条。',
        'table.delete': '删除',
        'table.duplicateKey': '该参数名已存在',
        'table.emptyKey': '请填写参数名',
        'types.string': '字符串',
        'types.integer': '整数',
        'types.float': '浮点数',
        'types.boolean': '布尔值',
        'types.array': '数组',
        'actions.cancel': '取消',
        'unsavedChangesDialog.title': '未保存的更改',
        'unsavedChangesDialog.description': '刷新将丢弃未保存的更改。',
        'unsavedChangesDialog.refreshAnyway': '仍然刷新',
      };
      return strings[key] ?? key;
    },
  }),
}));

jest.mock('lucide-react', () => ({
  Search: () => <span data-testid="search-icon" />,
  RefreshCw: () => <span data-testid="refresh-icon" />,
  AlertTriangle: () => <span data-testid="alert-icon" />,
  MoreHorizontal: () => <span data-testid="more-horizontal-icon" />,
  Trash2: () => <span data-testid="trash-icon" />,
}));

jest.mock('lib/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
}));

jest.mock('@/components/ui/select', () => {
  const React = require('react');
  return {
    Select: ({
      children,
      value,
      onValueChange,
      disabled,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
      disabled?: boolean;
    }) => (
      <div data-testid="type-select" data-value={value}>
        {React.Children.map(children, (child: React.ReactNode) =>
          React.isValidElement(child)
            ? React.cloneElement(child as React.ReactElement, {
                value,
                onValueChange,
                disabled,
              })
            : child,
        )}
      </div>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => (
      <button type="button">{children}</button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      children,
      value: itemValue,
      onValueChange,
      disabled,
    }: {
      children: React.ReactNode;
      value: string;
      onValueChange?: (value: string) => void;
      disabled?: boolean;
    }) => (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onValueChange?.(itemValue)}
      >
        {children}
      </button>
    ),
  };
});

jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => (asChild ? <>{children}</> : <button type="button">{children}</button>),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <button
      type="button"
      disabled={disabled}
      className={className}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

jest.mock('@/components/ui/tabs', () => {
  const React = require('react');
  const Context = React.createContext('body');
  return {
    Tabs: ({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) => <Context.Provider value={value}>{children}</Context.Provider>,
    TabsList: ({ children }: { children: React.ReactNode }) => (
      <div role="tablist">{children}</div>
    ),
    TabsTrigger: ({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) => {
      const active = React.useContext(Context);
      return (
        <button role="tab" aria-selected={active === value} data-value={value}>
          {children}
        </button>
      );
    },
    TabsContent: ({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) => {
      const active = React.useContext(Context);
      return active === value ? (
        <div data-testid={`tab-content-${value}`}>{children}</div>
      ) : null;
    },
  };
});

jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
}));

jest.mock('@/components/ui/table', () => ({
  Table: ({ children }: { children: React.ReactNode }) => (
    <table>{children}</table>
  ),
  TableHeader: ({ children }: { children: React.ReactNode }) => (
    <thead>{children}</thead>
  ),
  TableBody: ({ children }: { children: React.ReactNode }) => (
    <tbody>{children}</tbody>
  ),
  TableRow: ({ children }: { children: React.ReactNode }) => (
    <tr>{children}</tr>
  ),
  TableHead: ({ children }: { children: React.ReactNode }) => (
    <th>{children}</th>
  ),
  TableCell: ({ children }: { children: React.ReactNode }) => (
    <td>{children}</td>
  ),
}));

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

describe('CustomParameterEditor', () => {
  const mockConfig: CustomParameterConfig = {
    headerParameters: { Authorization: 'Bearer x' },
    bodyParameters: { temperature: 0.7 },
  };

  const addBodyParameter = jest.fn();
  const removeBodyParameter = jest.fn();

  const buildHookReturn = (
    overrides: Partial<ReturnType<typeof useParameterConfig>> = {},
  ) => ({
    state: {
      config: mockConfig,
      isLoading: false,
      hasUnsavedChanges: false,
      validationErrors: [],
      lastSaved: Date.now(),
      saveStatus: 'idle' as const,
    },
    loadConfig: jest.fn(),
    saveConfig: jest.fn(),
    addBodyParameter,
    updateBodyParameter: jest.fn(),
    removeBodyParameter,
    addHeaderParameter: jest.fn(),
    updateHeaderParameter: jest.fn(),
    removeHeaderParameter: jest.fn(),
    validateConfiguration: jest.fn(),
    exportConfiguration: jest.fn(() => '{}'),
    importConfiguration: jest.fn(),
    getSupportedParameters: jest.fn(),
    getParameterDefinition: jest.fn(async (key: string) =>
      key.toLowerCase() === 'temperature' || key.toLowerCase() === 'max_tokens'
        ? {
            key: key.toLowerCase(),
            type: 'number' as const,
            category: 'behavior' as const,
            required: false,
            providerSupport: ['*'],
          }
        : null,
    ),
    resetConfig: jest.fn(),
    enableAutoSave: jest.fn(),
    disableAutoSave: jest.fn(),
    getMigrationStatus: jest.fn(),
    getAppliedMigrations: jest.fn(),
    getAvailableMigrations: jest.fn(),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseParameterConfig.mockReturnValue(buildHookReturn());
  });

  it('renders tabs with badge counts', () => {
    render(<CustomParameterEditor providerId="openai" />);

    expect(screen.getByRole('tab', { name: /请求头/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /请求体参数/ })).toBeInTheDocument();

    const badges = screen.getAllByTestId('badge');
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent('1');
    expect(badges[1]).toHaveTextContent('1');
  });

  it('commits draft row via addBodyParameter on blur', async () => {
    render(<CustomParameterEditor providerId="openai" />);

    const keyInput = screen.getByPlaceholderText('例如 temperature');
    const valueInput = screen.getByPlaceholderText('例如 0.3');

    fireEvent.change(keyInput, { target: { value: 'max_tokens' } });
    fireEvent.change(valueInput, { target: { value: '1000' } });
    fireEvent.blur(valueInput);

    await waitFor(() => {
      expect(addBodyParameter).toHaveBeenCalledWith(
        'max_tokens',
        1000,
        'float',
      );
    });
  });

  it('allows adding a second body parameter', async () => {
    let bodyParameters: Record<string, ParameterValue> = {};
    const localAddBodyParameter = jest.fn(
      (key: string, value: ParameterValue, _type: string) => {
        bodyParameters = { ...bodyParameters, [key]: value };
      },
    );

    mockUseParameterConfig.mockImplementation(() =>
      buildHookReturn({
        state: {
          config: {
            headerParameters: {},
            bodyParameters,
            configVersion: '1.0.0',
            lastModified: Date.now(),
          },
          isLoading: false,
          hasUnsavedChanges: false,
          validationErrors: [],
          lastSaved: Date.now(),
          saveStatus: 'idle' as const,
        },
        addBodyParameter: localAddBodyParameter,
        getParameterDefinition: jest.fn(async (key: string) => {
          const normalized = key.toLowerCase();
          if (normalized === 'temperature' || normalized === 'max_tokens') {
            return {
              key: normalized,
              type: 'number' as const,
              category: 'behavior' as const,
              required: false,
              providerSupport: ['*'],
            };
          }
          return null;
        }),
      }),
    );

    const { rerender } = render(<CustomParameterEditor providerId="openai" />);

    const fillDraftRow = (key: string, value: string) => {
      const keyInput = screen.getByPlaceholderText('例如 temperature');
      const valueInput = screen.getByPlaceholderText('例如 0.3');
      fireEvent.change(keyInput, { target: { value: key } });
      fireEvent.change(valueInput, { target: { value } });
      fireEvent.blur(valueInput);
    };

    fillDraftRow('temperature', '0.3');

    await waitFor(() => {
      expect(localAddBodyParameter).toHaveBeenCalledWith(
        'temperature',
        0.3,
        'float',
      );
    });

    rerender(<CustomParameterEditor providerId="openai" />);
    fillDraftRow('max_tokens', '1000');

    await waitFor(() => {
      expect(localAddBodyParameter).toHaveBeenCalledTimes(2);
      expect(localAddBodyParameter).toHaveBeenLastCalledWith(
        'max_tokens',
        1000,
        'float',
      );
      expect(Object.keys(bodyParameters)).toEqual(
        expect.arrayContaining(['temperature', 'max_tokens']),
      );
    });
  });

  it('calls removeBodyParameter when row remove is selected', () => {
    render(<CustomParameterEditor providerId="openai" />);

    const bodyTab = screen.getByTestId('tab-content-body');
    const removeButton = within(bodyTab)
      .getAllByRole('button')
      .find((button) => button.querySelector('[data-testid="trash-icon"]'));

    expect(removeButton).toBeDefined();
    fireEvent.click(removeButton!);

    expect(removeBodyParameter).toHaveBeenCalledWith('temperature');
  });

  it('shows import and export actions in the more menu', () => {
    render(<CustomParameterEditor providerId="openai" />);

    expect(screen.getByRole('button', { name: '更多' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '导入 JSON' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '导出 JSON' }),
    ).toBeInTheDocument();
  });

  it('shows add hint and explicit add button', () => {
    render(<CustomParameterEditor providerId="openai" />);

    expect(screen.getByRole('button', { name: '添加' })).toBeInTheDocument();
    expect(
      screen.getByText(
        '在下方「新参数」行填写参数名、类型和值，点击「添加」或按 Enter 可连续添加多条。',
      ),
    ).toBeInTheDocument();
  });
});
