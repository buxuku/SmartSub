import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TaskActivityDetails } from '../tasks/TaskActivityDetails';
import { TaskActivityReporter } from '../../../main/helpers/taskActivity';
import {
  latestTaskActivity,
  type TaskActivity,
} from '../../../types/taskActivity';
import useIpcCommunication from '../../hooks/useIpcCommunication';
import { getTaskDisplayStatus, type StageDef } from '../tasks/stageUtils';
import zh from '../../public/locales/zh/tasks.json';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const text =
        key.split('.').reduce((obj, part) => obj?.[part], zh as any) ?? key;
      return String(text).replace(/{{(\w+)}}/g, (_, name) =>
        String(values[name] ?? ''),
      );
    },
  }),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(100_000);
});
afterEach(() => jest.useRealTimers());

function activity(extra: Partial<TaskActivity> = {}): TaskActivity {
  return {
    run: 1,
    sequence: 1,
    stage: 'refineSubtitle',
    status: 'running',
    phase: 'segmenting',
    startedAt: 100_000,
    phaseStartedAt: 100_000,
    updatedAt: 100_000,
    completed: 0,
    total: 24,
    unit: 'batches',
    units: [
      {
        id: 1,
        phase: 'requesting',
        startedAt: 100_000,
        requestStartedAt: 100_000,
      },
    ],
    ...extra,
  };
}

it('advances waiting time without manufacturing processing progress', () => {
  const { rerender } = render(<TaskActivityDetails activity={activity()} />);
  act(() => jest.advanceTimersByTime(65_000));
  expect(screen.getByTestId('task-activity')).toHaveTextContent(
    '已处理 0/24 批',
  );
  expect(screen.getByTestId('task-activity')).toHaveTextContent(
    '该请求尚未返回',
  );
  expect(screen.getByRole('status')).toHaveTextContent('AI 断句');
  rerender(
    <TaskActivityDetails
      activity={activity({ phase: 'saving', completed: 24, units: [] })}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('正在保存字幕');
  expect(screen.queryByText('已处理 24/24 批')).not.toBeInTheDocument();
  rerender(
    <TaskActivityDetails activity={activity({ status: 'done', units: [] })} />,
  );
  expect(screen.getByTestId('task-activity')).toHaveTextContent('处理完成');
  expect(jest.getTimerCount()).toBe(0);
});

it('preserves a truthful fallback/save failure summary without a live clock', () => {
  const snapshot = activity({
    status: 'done',
    summary: {
      segmentation: { total: 24, accepted: 22, fallback: 2 },
      correctionFailed: 3,
    },
  });
  const { rerender } = render(<TaskActivityDetails activity={snapshot} />);
  expect(screen.getByText(/22 批使用 AI 结果，2 批使用规则断句/)).toBeVisible();
  expect(jest.getTimerCount()).toBe(0);
  rerender(
    <TaskActivityDetails
      activity={{
        ...snapshot,
        summary: { ...snapshot.summary, saveFailed: true },
      }}
    />,
  );
  expect(screen.getByText(/优化结果未保存，已保留输入字幕。/)).toBeVisible();
  expect(screen.queryByText(/22 批使用/)).not.toBeInTheDocument();
});

it('throttles numbers, immediately sends stage changes, and rejects closed stage callbacks', () => {
  const events: TaskActivity[] = [];
  const controller = new AbortController();
  const reporter = new TaskActivityReporter(
    10,
    (event) => events.push(event),
    controller.signal,
  );
  const asr = reporter.start('extractSubtitle', 'recognizing');
  asr.update({ phase: 'recognizing', processedSeconds: 1 });
  asr.update({ phase: 'recognizing', processedSeconds: 2 });
  expect(events).toHaveLength(2);
  act(() => jest.advanceTimersByTime(250));
  expect(events.at(-1)?.processedSeconds).toBe(2);
  asr.finish();
  const refine = reporter.start('refineSubtitle', 'segmenting');
  asr.update({ phase: 'saving' });
  expect(events.at(-1)?.phase).toBe('segmenting');
  controller.abort();
  expect(events.at(-1)?.status).toBe('cancelling');
  refine.update({ phase: 'saving' });
  refine.finish('cancelled');
  reporter.close();
  const count = events.length;
  refine.update({ phase: 'saving' });
  act(() => jest.advanceTimersByTime(1000));
  expect(events).toHaveLength(count);
  expect(events.at(-1)?.status).toBe('cancelled');
  expect(jest.getTimerCount()).toBe(0);
});

it('orders execution generations before sequence numbers', () => {
  const current = activity({ run: 4, sequence: 10 });
  expect(latestTaskActivity(current, activity({ run: 3, sequence: 100 }))).toBe(
    current,
  );
  expect(latestTaskActivity(current, activity({ run: 4, sequence: 9 }))).toBe(
    current,
  );
  expect(
    latestTaskActivity(current, activity({ run: 5, sequence: 1 }))?.run,
  ).toBe(5);
});

it('reconciles hydration races and prevents generic file events from restoring stale activity', () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  (window as any).ipc = {
    on: (channel, cb) => {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    },
  };
  let hydrate: ReturnType<typeof useIpcCommunication>['hydrateFiles'];
  function Harness({ project = 'a' }) {
    const [files, setFiles] = React.useState<any[]>([]);
    hydrate = useIpcCommunication(setFiles, undefined, project).hydrateFiles;
    return <div data-testid="state">{JSON.stringify(files)}</div>;
  }
  const { rerender } = render(<Harness />);
  const emit = (channel, ...args) =>
    act(() => listeners.get(channel)?.(...args));
  emit(
    'taskActivityChange',
    { uuid: 'file', taskProjectId: 'a' },
    activity({ sequence: 2 }),
  );
  emit('taskFileChange', {
    uuid: 'file',
    taskProjectId: 'a',
    taskActivity: activity(),
  });
  act(() =>
    hydrate([
      {
        uuid: 'file',
        taskActivity: activity({ sequence: 3, phase: 'saving' }),
      } as any,
    ]),
  );
  expect(screen.getByTestId('state')).toHaveTextContent('"phase":"saving"');
  emit(
    'taskActivityChange',
    { uuid: 'file', taskProjectId: 'b' },
    activity({ run: 2 }),
  );
  emit('taskFileChange', {
    uuid: 'file',
    taskProjectId: 'a',
    taskActivity: activity(),
  });
  expect(screen.getByTestId('state')).toHaveTextContent('"sequence":3');
  emit(
    'taskActivityChange',
    { uuid: 'file', taskProjectId: 'a' },
    activity({ run: 2 }),
  );
  emit(
    'taskActivityChange',
    { uuid: 'file', taskProjectId: 'a' },
    activity({ run: 1, sequence: 100 }),
  );
  expect(screen.getByTestId('state')).toHaveTextContent('"run":2');
  rerender(<Harness project="b" />);
  emit(
    'taskActivityChange',
    { uuid: 'file', taskProjectId: 'a' },
    activity({ run: 3 }),
  );
  expect(screen.getByTestId('state')).toHaveTextContent('"run":2');
});

it('keeps one fixed status slot through ordinary stages, gates and terminal states', () => {
  const stages: StageDef[] = [
    { key: 'extractAudio', labelKey: 'stage.extract' },
    { key: 'extractSubtitle', labelKey: 'stage.transcribe' },
    { key: 'translateSubtitle', labelKey: 'stage.translate' },
  ];
  expect(getTaskDisplayStatus({}, stages, 'idle', null).state).toBe('idle');
  expect(getTaskDisplayStatus({}, stages, 'running', null).state).toBe(
    'queued',
  );
  expect(getTaskDisplayStatus({}, stages, 'paused', null).state).toBe('paused');
  expect(
    getTaskDisplayStatus({ extractAudio: 'loading' }, stages, 'running', null)
      .stage,
  ).toBe('extractAudio');
  expect(
    getTaskDisplayStatus(
      { extractAudio: 'loading' },
      stages,
      'cancelling',
      null,
    ).state,
  ).toBe('cancelling');
  expect(
    getTaskDisplayStatus({}, stages, 'waiting', {
      key: 'subtitleGate',
      labelKey: 'gate.subtitle',
    }).state,
  ).toBe('gate');
  expect(
    getTaskDisplayStatus({ extractAudio: 'error' }, stages, 'idle', null).state,
  ).toBe('error');
  expect(
    getTaskDisplayStatus(
      { taskActivity: activity({ status: 'cancelled' }) },
      stages,
      'idle',
      null,
    ).state,
  ).toBe('cancelled');
  expect(
    getTaskDisplayStatus(
      {
        extractAudio: 'done',
        extractSubtitle: 'done',
        translateSubtitle: 'done',
      },
      stages,
      'idle',
      null,
    ).state,
  ).toBe('done');

  const { rerender } = render(
    <TaskActivityDetails state="idle" statusText="等待开始" />,
  );
  const slot = screen.getByTestId('task-activity');
  expect(slot).toHaveClass('h-6');
  rerender(
    <TaskActivityDetails
      activity={activity()}
      state="running"
      stage="refineSubtitle"
    />,
  );
  expect(screen.getByTestId('task-activity')).toBe(slot);
  fireEvent.click(screen.getByRole('button', { name: '查看处理详情' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('第 1 批');
  expect(slot).not.toContainElement(screen.getByRole('dialog'));
  rerender(
    <TaskActivityDetails
      activity={activity()}
      state="running"
      stage="translateSubtitle"
      statusText="正在翻译"
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('正在翻译');
  expect(slot).not.toHaveTextContent('AI 断句');
  // Radix focus management schedules a one-shot callback when opening.
  act(() => jest.advanceTimersByTime(1000));
  expect(jest.getTimerCount()).toBe(0);
  for (const state of ['gate', 'done', 'error', 'cancelled']) {
    rerender(<TaskActivityDetails state={state} statusText={state} />);
    expect(screen.getByTestId('task-activity')).toBe(slot);
    expect(slot).toHaveTextContent(state);
  }
});

it('shows translation receipt, saving, retries and seconds without reanimating the clock', () => {
  render(
    <TaskActivityDetails
      activity={activity({
        stage: 'translateSubtitle',
        phase: 'retrying',
        completed: 2,
        total: 4,
        savedBatches: 1,
        units: [
          {
            id: 3,
            phase: 'retrying',
            startedAt: 100_000,
            retry: 1,
            maxRetries: 2,
            waitUntil: 104_000,
          },
        ],
      })}
      state="running"
      stage="translateSubtitle"
    />,
  );
  const message = screen.getByTestId('task-activity-message');
  expect(message).toHaveTextContent('已返回 2/4 批 · 已写入 1 批');
  expect(message).toHaveTextContent('第 1/2 次重试 · 等待 4 秒');
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.getByTestId('task-activity-message')).toBe(message);
  expect(message).toHaveTextContent('等待 2 秒');
});
