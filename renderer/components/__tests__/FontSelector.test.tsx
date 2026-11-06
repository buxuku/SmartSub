import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import FontSelector from '../subtitleMerge/FontSelector';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// Real Radix layout, focus and dismissal are exercised by compose-font-menu E2E.
jest.mock('@/components/ui/popover', () => {
  const React = require('react');
  const Context = React.createContext({});
  return {
    Popover: ({ open, onOpenChange, children }: any) => (
      <Context.Provider value={{ open, onOpenChange }}>
        {children}
      </Context.Provider>
    ),
    PopoverTrigger: ({ children }: any) => {
      const { open, onOpenChange } = React.useContext(Context);
      return React.cloneElement(children, {
        onClick: () => onOpenChange(!open),
      });
    },
    PopoverContent: ({ children }: any) => {
      const { open, onOpenChange } = React.useContext(Context);
      return open ? (
        <div
          onKeyDown={(event) => {
            if (event.key === 'Escape') onOpenChange(false);
          }}
        >
          {children}
        </div>
      ) : null;
    },
  };
});
jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    scrollToIndex: jest.fn(),
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 12) }, (_, index) => ({
        index,
        size: 64,
        start: index * 64,
      })),
  }),
}));
const fonts = [
  { name: 'Alpha', available: true },
  { name: 'Missing', available: false },
  { name: 'Zulu', available: true },
];
let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn().mockResolvedValue({ success: true, data: fonts });
  window.ipc = { invoke } as any;
  global.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  } as any;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
});
it('searches fonts, skips unavailable rows with keyboard, and ignores IME confirmation', async () => {
  const change = jest.fn();
  render(<FontSelector value="Alpha" disabled={false} onChange={change} />);
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'fontFamily' }));
  });
  await waitFor(() =>
    expect(screen.getByTestId('font-list')).toHaveAttribute(
      'aria-busy',
      'false',
    ),
  );
  const search = screen.getByRole('combobox', { name: 'fontSearch' });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(change).toHaveBeenCalledWith('Zulu');
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'fontFamily' }));
  });
  await waitFor(() =>
    expect(screen.getByTestId('font-list')).toHaveAttribute(
      'aria-busy',
      'false',
    ),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'fontSearch' }), {
    target: { value: 'nothing' },
  });
  expect(screen.getByText('fontNoResults')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: 'fontSearch' }), {
    target: { value: 'zUL' },
  });
  expect(screen.getAllByRole('option')).toHaveLength(1);
});
it('keeps list failures visible, retries, and prevents selection while a refresh is unresolved', async () => {
  invoke.mockResolvedValueOnce({ success: false });
  const change = jest.fn();
  render(<FontSelector value="Alpha" disabled={false} onChange={change} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'fontFamily' }));
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('fontListFailed');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'previewRetry' }));
  });
  await waitFor(() =>
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.getByTestId('font-list')).toHaveAttribute(
      'aria-busy',
      'false',
    ),
  );
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'fontSearch' }), {
    key: 'Escape',
  });
  let resolve!: (result: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'fontFamily' }));
  });
  fireEvent.click(screen.getByRole('option', { name: /^Zulu/ }));
  expect(change).not.toHaveBeenCalled();
  await act(async () => resolve({ success: true, data: fonts }));
  fireEvent.click(screen.getByRole('option', { name: /^Zulu/ }));
  expect(change).toHaveBeenCalledWith('Zulu');
});
it('closes and isolates a delayed response when changing subtitle documents', async () => {
  let resolve!: (result: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { rerender } = render(
    <FontSelector
      value="Alpha"
      disabled={false}
      onChange={jest.fn()}
      subtitlePath="/old.ass"
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'fontFamily' }));
  });
  rerender(
    <FontSelector
      value="Alpha"
      disabled={false}
      onChange={jest.fn()}
      subtitlePath="/new.ass"
    />,
  );
  await act(async () =>
    resolve({
      success: true,
      data: [{ name: 'Old embedded', available: true }],
    }),
  );
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'fontFamily' }));
  });
  await waitFor(() =>
    expect(screen.getByTestId('font-list')).toHaveAttribute(
      'aria-busy',
      'false',
    ),
  );
  expect(screen.queryByText('Old embedded')).not.toBeInTheDocument();
  expect(invoke).toHaveBeenLastCalledWith('subtitleMerge:listFonts', {
    subtitlePath: '/new.ass',
  });
});

it('closes on disable and ignores a late listing failure', async () => {
  let reject!: (error: Error) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const change = jest.fn();
  const { rerender } = render(
    <FontSelector value="Alpha" disabled={false} onChange={change} />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'fontFamily' }));
  });
  rerender(<FontSelector value="Alpha" disabled onChange={change} />);
  await act(async () => reject(new Error('Late failure')));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'fontFamily' })).toBeDisabled();
  expect(change).not.toHaveBeenCalled();
});

const groupedFonts = [
  { name: 'Zeta', available: true },
  { name: 'Arial', available: true, rank: 24 },
  {
    name: 'Heiti SC',
    displayName: '黑体-简',
    localizedNames: ['黑体-简'],
    available: true,
    rank: 6,
  },
  { name: 'Gone', available: false, reason: 'missing' },
];
const openList = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'fontFamily' }));
  });
  await waitFor(() =>
    expect(screen.getByTestId('font-list')).toHaveAttribute(
      'aria-busy',
      'false',
    ),
  );
};

it('shows recent and common fonts first, with localized names, and unavailable ones last', async () => {
  window.localStorage.setItem('smartsub:recentFonts', '["Zeta"]');
  invoke.mockResolvedValue({ success: true, data: groupedFonts });
  render(<FontSelector value="Arial" disabled={false} onChange={jest.fn()} />);
  await openList();
  const groups = Array.from(
    screen.getByTestId('font-list').querySelectorAll('[data-font-group]'),
  ).map((node) => node.getAttribute('data-font-group'));
  expect(groups).toEqual(['recent', 'common', 'unavailable']);
  const options = screen.getAllByRole('option').map((node) => node.textContent);
  expect(options[0]).toMatch(/^Zeta/);
  expect(options[1]).toMatch(/^黑体-简Heiti SC/);
  expect(options[2]).toMatch(/^Arial/);
  expect(options[3]).toMatch(/^Gone/);
  expect(screen.getAllByRole('option')[1]).toHaveAttribute(
    'aria-posinset',
    '2',
  );
  expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-setsize', '4');
});

it('finds a font by its Chinese name, pinyin or initials and remembers the pick', async () => {
  window.localStorage.clear();
  invoke.mockResolvedValue({ success: true, data: groupedFonts });
  const change = jest.fn();
  render(<FontSelector value="Arial" disabled={false} onChange={change} />);
  await openList();
  for (const query of ['黑体', 'heiti', 'htj']) {
    fireEvent.change(screen.getByRole('combobox', { name: 'fontSearch' }), {
      target: { value: query },
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  }
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'fontSearch' }), {
    key: 'Enter',
  });
  expect(change).toHaveBeenCalledWith('Heiti SC');
  expect(
    JSON.parse(window.localStorage.getItem('smartsub:recentFonts')!),
  ).toEqual(['Heiti SC']);
});
