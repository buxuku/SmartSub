import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import TaskSettingsSheet from '../tasks/TaskSettingsSheet';
import { getTaskTypeBySlug } from '../../lib/taskTypes';
import { defaultUserConfig } from '../../../main/helpers/utils';

/**
 * Where focus lands when 更多设置 opens, with the real Radix dialog.
 *
 * Radix focuses the first tabbable element of a dialog. A task that only translates (or
 * works from a subtitle) has one page and no tab list, and the first thing on it can be the
 * ⓘ next to a label. Focusing an ⓘ opens its tooltip, so the panel would open with a hint
 * floating over the first row, and that tooltip is the top-most layer: the first Escape
 * closes the tooltip and the panel stays (the e2e `speaker-pipeline` hit exactly this).
 * `TaskSettingsSheet.test.tsx` swaps the dialog for a plain element, so it cannot see any of
 * it.
 *
 * The tooltip is a stand-in that opens on focus, like Radix's: positioning a real one takes
 * jsdom about 30 seconds, and what matters here is only whether focus lands on the ⓘ.
 */
jest.mock('electron', () => ({ app: {} }));
jest.mock('next-i18next', () => {
  const i18next = jest.requireActual('i18next');
  const zh = i18next.createInstance();
  zh.init({
    lng: 'zh',
    ns: ['tasks', 'home', 'common'],
    defaultNS: 'tasks',
    resources: {
      zh: {
        tasks: jest.requireActual('../../public/locales/zh/tasks.json'),
        home: jest.requireActual('../../public/locales/zh/home.json'),
        common: jest.requireActual('../../public/locales/zh/common.json'),
      },
    },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  return {
    useTranslation: (ns: string = 'tasks') => ({
      t: zh.getFixedT('zh', ns),
    }),
  };
});

jest.mock('@/components/ui/tooltip', () => {
  const React = require('react');
  const Context = React.createContext({
    open: false,
    setOpen: (_: boolean) => {},
  });
  return {
    TooltipProvider: ({ children }: any) => <>{children}</>,
    Tooltip: ({ children }: any) => {
      const [open, setOpen] = React.useState(false);
      return (
        <Context.Provider value={{ open, setOpen }}>
          {children}
        </Context.Provider>
      );
    },
    TooltipTrigger: ({ children }: any) => {
      const { setOpen } = React.useContext(Context);
      return React.cloneElement(children, {
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
      });
    },
    TooltipContent: ({ children }: any) => {
      const { open } = React.useContext(Context);
      return open ? <div role="tooltip">{children}</div> : null;
    },
  };
});
// The scroll area and the select cost seconds in jsdom (the scroll area measures itself in a
// loop), and neither takes part in focus.
jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/ui/select', () => {
  const React = require('react');
  const passthrough = ({ children }: any) => <div>{children}</div>;
  return {
    Select: passthrough,
    SelectTrigger: React.forwardRef(({ children, ...props }: any, ref: any) => (
      <button type="button" role="combobox" ref={ref} {...props}>
        {children}
      </button>
    )),
    SelectValue: () => null,
    SelectContent: passthrough,
    SelectItem: passthrough,
  };
});

const TRANSLATE = getTaskTypeBySlug('translate')!;
const GENERATE = getTaskTypeBySlug('generate')!;

function Harness({
  typeDef,
  onOpenChange,
}: {
  typeDef: any;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useForm<any>({
    defaultValues: { ...defaultUserConfig, subtitleOutcome: 'balanced' },
  });
  return (
    <TaskSettingsSheet
      open
      onOpenChange={onOpenChange}
      form={form}
      formData={form.watch()}
      typeDef={typeDef}
      hasMediaInput
    />
  );
}

const open = async (typeDef: any) => {
  const onOpenChange = jest.fn();
  render(<Harness typeDef={typeDef} onOpenChange={onOpenChange} />);
  await act(async () => {});
  return onOpenChange;
};

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  window.ipc = {
    invoke: jest.fn(async () => ({})),
    send: jest.fn(),
    on: jest.fn(() => jest.fn()),
  } as any;
});

describe('focus when 更多设置 opens', () => {
  test('a one-page panel parks focus on the panel: no hint pops open and one Escape closes it', async () => {
    const onOpenChange = await open(TRANSLATE);

    // The page starts with the ⓘ of 角色分离; it must not be the focused element.
    expect(screen.getAllByTestId('setting-hint').length).toBeGreaterThan(0);
    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('a panel with tabs closes on the first Escape too', async () => {
    const onOpenChange = await open(GENERATE);

    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
