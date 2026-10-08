import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { toast } from 'sonner';
import TaskControls from '../TaskControls';
import { getTaskTypeBySlug } from '../../lib/taskTypes';

/**
 * Settings picked while editing a task belong to that task. Starting it is the one
 * explicit moment they become the defaults of the next new task ("last used").
 */
const mockSubmit = jest.fn();

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('sonner', () => ({
  toast: Object.assign(jest.fn(), { error: jest.fn() }),
}));
jest.mock('../../hooks/useTaskSubmission', () => ({
  useTaskSubmission: () => ({
    submit: (...args: unknown[]) => mockSubmit(...args),
    starting: false,
    phase: 'idle',
    dialog: null,
  }),
}));

const typeDef = getTaskTypeBySlug('generate')!;
const files = [
  { uuid: 'file-1', filePath: '/media/lesson.mp4', fileName: 'lesson' },
];
const reusable = {
  sourceLanguage: 'ja',
  targetLanguage: 'zh',
  transcriptionEngine: 'builtin',
  model: 'base',
  useEmbeddedSubtitles: false,
  speakerDiarization: true,
  maxContext: 6,
  customParameters: { temperature: 0.2 },
};
const draft = {
  ...reusable,
  taskType: 'generateOnly',
  manuscriptPath: '/media/script.txt',
};

let invoke: jest.Mock;
let remembered: () => unknown[][];

beforeEach(() => {
  invoke = jest.fn(async (channel: string) => {
    if (channel === 'getTaskStatus') return 'idle';
    if (channel === 'rememberTaskDefaults') return { success: true };
    if (channel === 'setSettings') return {};
    throw new Error(`Unexpected IPC ${channel}`);
  });
  remembered = () =>
    invoke.mock.calls.filter(([channel]) => channel === 'rememberTaskDefaults');
  window.ipc = { invoke, send: jest.fn(), on: jest.fn(() => jest.fn()) } as any;
  mockSubmit.mockReset();
  mockSubmit.mockImplementation(async (input) => ({
    status: 'accepted',
    snapshot: input.formData,
    projectId: input.projectId,
  }));
});

function controls(props: Record<string, unknown> = {}, formData = draft) {
  return (
    <TaskControls
      files={files}
      formData={formData}
      typeDef={typeDef}
      projectId="project-1"
      {...props}
    />
  );
}

async function start() {
  const button = await screen.findByRole('button', { name: 'home:startTask' });
  await act(async () => {
    fireEvent.click(button);
  });
}

test('a task the main process accepted becomes the default of the next new task', async () => {
  const dispatched = jest.fn();
  render(controls({ rememberDefaults: true, onTaskDispatched: dispatched }));
  await start();
  await waitFor(() => expect(remembered()).toHaveLength(1));
  // Per-task inputs (task type, reference manuscript) are not preferences.
  expect(remembered()[0]).toEqual(['rememberTaskDefaults', reusable]);
  expect(dispatched).toHaveBeenCalledTimes(1);
  // The existing engine/model memory keeps working alongside it.
  expect(invoke).toHaveBeenCalledWith('setSettings', {
    lastUsedTranscription: { engine: 'builtin', model: 'base' },
  });
});

test('nothing is remembered before the main process acknowledges the task', async () => {
  let accept!: (outcome: unknown) => void;
  mockSubmit.mockReturnValue(
    new Promise((resolve) => {
      accept = resolve;
    }),
  );
  render(controls({ rememberDefaults: true }));
  await start();
  expect(remembered()).toHaveLength(0);
  await act(async () => {
    accept({
      status: 'accepted',
      snapshot: { ...draft, maxContext: 9 },
      projectId: 'project-1',
    });
  });
  await waitFor(() => expect(remembered()).toHaveLength(1));
  // What is remembered is the configuration that was actually accepted.
  expect(remembered()[0][1]).toEqual({ ...reusable, maxContext: 9 });
});

test.each([
  [
    'invalid',
    {
      status: 'invalid',
      readiness: { errors: ['noModel'], refine: { valid: true } },
    },
  ],
  ['cancelled', { status: 'cancelled' }],
])('a %s start leaves the defaults alone', async (_label, outcome) => {
  mockSubmit.mockResolvedValue(outcome);
  render(controls({ rememberDefaults: true }));
  await start();
  await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
  expect(remembered()).toHaveLength(0);
});

test('a start the main process rejected is reported and leaves the defaults alone', async () => {
  mockSubmit.mockRejectedValue(new Error('TASK_SUBMISSION_NOT_ACKNOWLEDGED'));
  render(controls({ rememberDefaults: true }));
  await start();
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      'TASK_SUBMISSION_NOT_ACKNOWLEDGED',
    ),
  );
  expect(remembered()).toHaveLength(0);
});

test.each([
  ['a pinned snapshot is restarted', { rememberDefaults: false }],
  ['the host does not ask for it', {}],
])('nothing is remembered when %s', async (_label, props) => {
  const dispatched = jest.fn();
  render(controls({ ...props, onTaskDispatched: dispatched }));
  await start();
  await waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
  expect(remembered()).toHaveLength(0);
});

test.each([
  ['rejects', () => Promise.reject(new Error('EACCES'))],
  ['is not acknowledged', () => Promise.resolve({ success: false })],
])(
  'a save that %s never turns a started task into a failure',
  async (_label, outcome) => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'getTaskStatus') return 'idle';
      if (channel === 'rememberTaskDefaults') return outcome();
      return {};
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const dispatched = jest.fn();
    render(controls({ rememberDefaults: true, onTaskDispatched: dispatched }));
    await start();
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        'Failed to remember task defaults:',
        expect.any(Error),
      ),
    );
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    log.mockRestore();
  },
);

test('editing a draft never writes the defaults; only starting does', async () => {
  const view = render(controls({ rememberDefaults: true }));
  await screen.findByRole('button', { name: 'home:startTask' });
  view.rerender(
    controls({ rememberDefaults: true }, { ...draft, maxContext: 9 }),
  );
  expect(remembered()).toHaveLength(0);
  expect(window.ipc.send).not.toHaveBeenCalled();
});
