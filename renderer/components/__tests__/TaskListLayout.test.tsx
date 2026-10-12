import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import TaskRowList from '../tasks/TaskRowList';
import TaskGridList from '../tasks/TaskGridList';
import { TASK_TYPES } from '../../lib/taskTypes';
import zh from '../../public/locales/zh/tasks.json';
import en from '../../public/locales/en/tasks.json';

/**
 * Layout contract for the task list. jsdom has no layout engine, so these tests
 * pin the structure that keeps cards and rows stable (no display toggling, fixed
 * slots, visible outlines); scripts/e2e/task-list-layout.mjs measures the result
 * in a real window.
 */
const longName =
  'interview-with-the-founder-about-building-a-subtitle-tool-final-cut-v12';
const media = {
  filePath: `/tmp/${longName}.mp4`,
  fileName: longName,
  fileExtension: '.mp4',
  fileSize: 12_345_678,
  duration: 34,
};
const idle = { ...media, uuid: 'idle' };
const running = {
  ...media,
  uuid: 'running',
  extractAudio: 'done',
  extractSubtitle: 'loading',
  extractSubtitleProgress: 40,
};
const failed = {
  ...media,
  uuid: 'failed',
  extractAudio: 'done',
  extractSubtitle: 'error',
  extractSubtitleError: 'Connection timed out',
};
const done = {
  ...media,
  uuid: 'done',
  extractAudio: 'done',
  extractSubtitle: 'done',
};

beforeAll(() => {
  global.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof IntersectionObserver;
});

type ListProps = Partial<React.ComponentProps<typeof TaskRowList>>;

async function renderList(
  Component: typeof TaskRowList | typeof TaskGridList,
  files: Record<string, unknown>[],
  {
    language = 'zh',
    formData = { taskType: 'generateOnly' },
    taskStatus = 'idle',
    ...props
  }: ListProps & { language?: 'zh' | 'en' } = {},
) {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: false,
    resources: { zh: { tasks: zh }, en: { tasks: en } },
    interpolation: { escapeValue: false },
  });
  const view = render(
    <I18nextProvider i18n={i18n}>
      <Component
        files={files}
        typeDef={TASK_TYPES[1]}
        formData={formData}
        taskStatus={taskStatus}
        onProofread={jest.fn()}
        onDelete={jest.fn()}
        onRetry={jest.fn()}
        {...props}
      />
    </I18nextProvider>,
  );
  return { ...view, t: i18n.getFixedT(language, 'tasks') };
}

describe.each([
  ['list', TaskRowList, 'task-row'],
  ['grid', TaskGridList, 'task-card'],
] as const)('%s entries', (_mode, Component, shellId) => {
  it('outlines every entry so neighbouring entries can be told apart', async () => {
    await renderList(Component, [idle, done]);
    const shells = screen.getAllByTestId(shellId);
    expect(shells).toHaveLength(2);
    for (const shell of shells) {
      expect(shell).toHaveClass('border', 'border-border-strong');
      expect(shell).not.toHaveClass('border-transparent');
    }
  });

  it.each([
    ['running', running, 'running', 'border-primary/50', 'bg-primary'],
    ['failed', failed, 'error', 'border-destructive/50', 'bg-destructive'],
    ['finished', done, 'done', 'border-border-strong', 'bg-success'],
  ])('tints a %s entry', async (_label, file, tone, borderClass, barClass) => {
    await renderList(Component, [file], {
      taskStatus: file === running ? 'running' : 'idle',
    });
    const shell = screen.getByTestId(shellId);
    expect(shell).toHaveAttribute('data-tone', tone);
    expect(shell).toHaveClass(borderClass);
    expect(screen.getByRole('progressbar').firstChild).toHaveClass(barClass);
  });

  it('keeps the extension visible when a long name is truncated', async () => {
    await renderList(Component, [idle]);
    const name = screen.getByTestId('task-name');
    expect(within(name).getByText(longName)).toHaveClass('truncate');
    const ext = within(name).getByTestId('task-name-ext');
    expect(ext).toHaveTextContent('.mp4');
    expect(ext).toHaveClass('shrink-0');
  });

  it('gives every pipeline chip an icon so its width stays put while running', async () => {
    await renderList(Component, [idle, running, failed, done], {
      taskStatus: 'running',
    });
    const chips = screen.getAllByTestId('rail-chip');
    expect(chips).toHaveLength(8);
    for (const chip of chips) {
      expect(chip.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    }
  });

  it('shows a single plus in the add-script chip', async () => {
    const { t } = await renderList(Component, [idle]);
    const chip = screen.getByTitle(t('manuscript.addScript'));
    expect(chip.querySelector('svg')).toBeNull();
    expect(chip.textContent).toBe(t('manuscript.addScript'));
  });

  it('reveals the remove button for keyboard users', async () => {
    const { t } = await renderList(Component, [idle]);
    expect(screen.getByRole('button', { name: t('row.remove') })).toHaveClass(
      'focus-visible:opacity-100',
    );
  });

  it('does not repeat the proofread action next to the gate review button', async () => {
    const atGate = {
      ...media,
      uuid: 'gate',
      extractAudio: 'done',
      extractSubtitle: 'done',
      subtitleGate: 'review',
    };
    await renderList(Component, [atGate], {
      language: 'en',
      taskStatus: 'running',
      formData: {
        taskType: 'generateOnly',
        compose: {},
        gates: { subtitle: 'manual' },
      },
    });
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Proofread' })).toBeNull();
  });

  it('lets a failed dubbing run be inspected', async () => {
    const { t } = await renderList(
      Component,
      [{ ...failed, uuid: 'failed-dub', dubbingSessionId: 'session-1' }],
      { onInspectDubbing: jest.fn() },
    );
    expect(
      screen.getByRole('button', { name: t('gate.inspectDubbing') }),
    ).toBeInTheDocument();
  });
});

describe('grid cards', () => {
  it('lays the cards out by minimum width instead of window breakpoints', async () => {
    await renderList(TaskGridList, [idle]);
    const grid = screen.getByTestId('task-grid');
    expect(grid.className).toContain(
      'grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]',
    );
    expect(grid.className).not.toMatch(/(^|\s)lg:grid-cols-4(\s|$)/);
  });

  it('keeps the manuscript chip in a fixed-height meta row and reveals it with opacity only', async () => {
    const { t } = await renderList(TaskGridList, [idle]);
    const meta = screen.getByTestId('task-card-meta');
    expect(meta).toHaveClass('h-6');
    expect(meta).toHaveTextContent('MB');
    const chip = within(meta).getByTitle(t('manuscript.addScript'));
    // display:none <-> inline-flex is what made the card grow on hover.
    expect(chip).not.toHaveClass('hidden');
    expect(chip).toHaveClass(
      'opacity-0',
      'group-hover:opacity-100',
      'focus-visible:opacity-100',
      'data-[state=open]:opacity-100',
    );
  });

  it('keeps the meta row in place when the chip has nothing to offer', async () => {
    await renderList(TaskGridList, [idle], { taskStatus: 'running' });
    // Busy queues hide the add chip; the row must keep its height regardless.
    const meta = screen.getByTestId('task-card-meta');
    expect(meta).toHaveClass('h-6');
    expect(within(meta).queryByRole('button')).toBeNull();
  });

  it('insets the text column and aligns the action icons with it', async () => {
    await renderList(TaskGridList, [idle]);
    expect(screen.getByTestId('task-card')).toHaveClass('p-3');
    expect(screen.getByTestId('task-card-body')).toHaveClass('px-1.5');
    expect(screen.getByTestId('task-actions')).toHaveClass(
      '-mr-1.5',
      'flex-wrap',
    );
  });
});

describe('list rows', () => {
  it('separates rows by 8px', async () => {
    await renderList(TaskRowList, [idle, done]);
    expect(screen.getByTestId('task-list')).toHaveClass('space-y-2');
  });

  it('reserves the ETA slot so progress bars line up across rows', async () => {
    await renderList(TaskRowList, [idle, running], { taskStatus: 'running' });
    const slots = screen.getAllByTestId('task-eta');
    expect(slots).toHaveLength(2);
    for (const slot of slots) expect(slot).toHaveClass('w-16', 'shrink-0');
  });

  it('aligns the status line with the file name and the chevron with the action icons', async () => {
    await renderList(TaskRowList, [idle]);
    expect(screen.getByTestId('task-activity')).toHaveClass('pl-5', 'pr-1.5');
  });
});
