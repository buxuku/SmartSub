import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import GlossarySelectControl from '../tasks/GlossarySelectControl';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
jest.mock('next/router', () => ({
  useRouter: () => ({ query: { locale: 'en' } }),
}));
jest.mock('../../hooks/useGlossaries', () => ({
  useGlossaries: () => ({
    loading: false,
    glossaries: [
      { id: 'g1', name: 'Medical terms', enabled: true },
      { id: 'g2', name: 'Legal terms', enabled: false },
    ],
  }),
}));
// Real Radix layout and dismissal are exercised by the task page E2E.
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
      const { open } = React.useContext(Context);
      return open ? <div>{children}</div> : null;
    },
  };
});

function openPopover() {
  const setValue = jest.fn();
  render(<GlossarySelectControl form={{ setValue }} formData={{} as any} />);
  fireEvent.click(
    screen.getByRole('button', {
      name: /configBar\.glossary: configBar\.glossaryAllEnabled/,
    }),
  );
  return setValue;
}

describe('GlossarySelectControl popover rows', () => {
  test('clicking a glossary name toggles it, not only the 16px checkbox', () => {
    const setValue = openPopover();

    // Untouched state falls back to "all enabled" = [g1]; ticking g2 by its name adds it.
    fireEvent.click(screen.getByText('Legal terms'));
    expect(setValue).toHaveBeenLastCalledWith('glossaryIds', ['g1', 'g2'], {
      shouldDirty: true,
    });

    // Clicking the name of a ticked glossary clears it (explicit empty selection).
    fireEvent.click(screen.getByText('Medical terms'));
    expect(setValue).toHaveBeenLastCalledWith('glossaryIds', [], {
      shouldDirty: true,
    });
  });

  test('the checkbox itself still toggles', () => {
    const setValue = openPopover();

    fireEvent.click(screen.getByRole('checkbox', { name: /Legal terms/ }));

    expect(setValue).toHaveBeenLastCalledWith('glossaryIds', ['g1', 'g2'], {
      shouldDirty: true,
    });
  });

  test('every checkbox has an accessible name and a unique id', () => {
    openPopover();

    const medical = screen.getByRole('checkbox', {
      name: 'Medical terms',
    }) as HTMLInputElement;
    // A disabled glossary keeps its status inside the same label.
    const legal = screen.getByRole('checkbox', {
      name: 'Legal terms configBar.glossaryDisabled',
    }) as HTMLInputElement;

    expect(medical.checked).toBe(true);
    expect(legal.checked).toBe(false);
    expect(medical.id).not.toBe('');
    expect(legal.id).not.toBe('');
    expect(medical.id).not.toBe(legal.id);
  });
});
