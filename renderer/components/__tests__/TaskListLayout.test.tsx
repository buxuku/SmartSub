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

  it('shows a single plus in the add-script chip', async () => {
    const { t } = await renderList(Component, [idle]);
    const chip = screen.getByTitle(t('manuscript.addScript'));
    expect(chip.querySelector('svg')).toBeNull();
    expect(chip.textContent).toBe(t('manuscript.addScript'));
  });
});

describe('grid cards', () => {
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
});

describe('list rows', () => {
  it('separates rows by 8px', async () => {
    await renderList(TaskRowList, [idle, done]);
    expect(screen.getByTestId('task-list')).toHaveClass('space-y-2');
  });
});
