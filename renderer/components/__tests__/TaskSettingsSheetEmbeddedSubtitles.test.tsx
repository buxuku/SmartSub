import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import TaskSettingsSheet from '../tasks/TaskSettingsSheet';
import { getTaskTypeBySlug } from '../../lib/taskTypes';

/**
 * The embedded subtitles switch used to sit at the bottom of the subtitle format popover;
 * it now leads 更多设置 › 常用 as the whole 字幕来源 group, which the task page and the
 * wizard share. Radix's dialog and scroll area are replaced by plain elements: they cost
 * seconds in jsdom and have nothing to do with what is asserted here.
 */
jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/sheet', () => {
  const passthrough = ({ children }: any) => <div>{children}</div>;
  return {
    Sheet: ({ open, children }: any) => (open ? <div>{children}</div> : null),
    SheetContent: passthrough,
    SheetHeader: passthrough,
    SheetTitle: passthrough,
    SheetDescription: passthrough,
  };
});
jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}));

const SWITCH = 'configBar.embeddedSubtitles';
let form: ReturnType<typeof useForm<any>>;

function Sheet({
  typeDef,
  hasMediaInput,
  defaults = {},
}: {
  typeDef: any;
  hasMediaInput?: boolean;
  defaults?: Record<string, unknown>;
}) {
  form = useForm({ defaultValues: defaults });
  return (
    <TaskSettingsSheet
      open
      onOpenChange={() => {}}
      form={form}
      formData={form.watch()}
      typeDef={typeDef}
      hasMediaInput={hasMediaInput}
    />
  );
}

const mount = async (props: React.ComponentProps<typeof Sheet>) => {
  render(<Sheet {...props} />);
  await act(async () => {});
};

beforeEach(() => {
  // Radix switches inside a <form> measure themselves.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  window.ipc = {
    invoke: jest.fn(async (channel: string) => {
      if (channel === 'getSettings') return {};
      if (channel === 'getSpeakerDiarizationModelStatus') return {};
      return undefined;
    }),
    send: jest.fn(),
    on: jest.fn(() => jest.fn()),
  } as any;
});

test('the subtitle source group leads the common page with the switch, on unless the task says otherwise', async () => {
  await mount({ typeDef: getTaskTypeBySlug('generate')! });
  const embedded = screen.getByRole('switch', { name: SWITCH });
  expect(embedded).toHaveAttribute('aria-checked', 'true');

  const source = screen.getByTestId('settings-group-source');
  expect(
    within(source).getByText('settings.groups.source'),
  ).toBeInTheDocument();
  expect(within(source).getByRole('switch', { name: SWITCH })).toBe(embedded);
  expect(
    within(source).getByRole('checkbox', {
      name: 'embeddedSubtitleSetting.promptLabel',
    }),
  ).toBeInTheDocument();

  // First on the page, ahead of every other group.
  const groups = screen
    .getAllByTestId(/^settings-group-/)
    .map((group) => group.getAttribute('data-testid'));
  expect(groups[0]).toBe('settings-group-source');
});

test('shows a task that forces speech recognition as switched off', async () => {
  await mount({
    typeDef: getTaskTypeBySlug('generate')!,
    defaults: { useEmbeddedSubtitles: false },
  });
  expect(screen.getByRole('switch', { name: SWITCH })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

test('switching it writes the task, marking the form dirty so the defaults follow', async () => {
  await mount({ typeDef: getTaskTypeBySlug('generate')! });
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: SWITCH }));
  });
  expect(form.getValues('useEmbeddedSubtitles')).toBe(false);
  expect(form.formState.dirtyFields.useEmbeddedSubtitles).toBe(true);
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: SWITCH }));
  });
  expect(form.getValues('useEmbeddedSubtitles')).toBe(true);
});

test('a task that does not transcribe has nothing to switch', async () => {
  await mount({ typeDef: getTaskTypeBySlug('translate')! });
  expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull();
});

test('nor does a media task that never runs speech recognition', async () => {
  // No such task exists today; the switch is about transcription, not about media.
  await mount({
    typeDef: { ...getTaskTypeBySlug('generate')!, needsModel: false },
  });
  expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull();
});

test('neither does a wizard run whose input is subtitle files', async () => {
  await mount({
    typeDef: getTaskTypeBySlug('generate')!,
    hasMediaInput: false,
  });
  expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull();
});
