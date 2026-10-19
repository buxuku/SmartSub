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
 * The defaults of the next new task follow the user's edits live (`syncDefaults` of
 * `useUnifiedTaskConfig`). Starting a task is not a moment that writes them: the only
 * thing TaskControls remembers is the last used engine and model.
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
const draft = {
  sourceLanguage: 'ja',
  targetLanguage: 'zh',
  transcriptionEngine: 'builtin',
  model: 'base',
  useEmbeddedSubtitles: false,
  speakerDiarization: true,
  maxContext: 6,
  customParameters: { temperature: 0.2 },
  taskType: 'generateOnly',
  manuscriptPath: '/media/script.txt',
};

let invoke: jest.Mock;
/** Every channel through which a default of the next task could be written. */
const DEFAULTS_CHANNELS = [
  'rememberTaskDefaults',
  'updateTaskDefaults',
  'setUserConfig',
];
const defaultsWrites = () =>
  [
    ...invoke.mock.calls.map(([channel]) => channel),
    ...(window.ipc.send as jest.Mock).mock.calls.map(([channel]) => channel),
  ].filter((channel) => DEFAULTS_CHANNELS.includes(channel));

beforeEach(() => {
  invoke = jest.fn(async (channel: string) => {
    if (channel === 'getTaskStatus') return 'idle';
    if (channel === 'setSettings') return {};
    throw new Error(`Unexpected IPC ${channel}`);
  });
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

test.each([
  ['by default', {}],
  // The 3.10 start-time memory had a prop; asking for it must not bring it back.
  [
    'even when a host still asks to remember on start',
    { rememberDefaults: true },
  ],
])(
  'a task the main process accepted records the engine and model, never the defaults (%s)',
  async (_label, props) => {
    const dispatched = jest.fn();
    render(controls({ ...props, onTaskDispatched: dispatched }));
    await start();
    await waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('setSettings', {
      lastUsedTranscription: { engine: 'builtin', model: 'base' },
    });
    expect(defaultsWrites()).toEqual([]);
  },
);

test.each([
  [
    'invalid',
    {
      status: 'invalid',
      readiness: { errors: ['noModel'], refine: { valid: true } },
    },
  ],
  ['cancelled', { status: 'cancelled' }],
])(
  'a %s start records nothing and writes no defaults',
  async (_label, outcome) => {
    mockSubmit.mockResolvedValue(outcome);
    render(controls());
    await start();
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(invoke).not.toHaveBeenCalledWith('setSettings', expect.anything());
    expect(defaultsWrites()).toEqual([]);
  },
);

test('a start the main process rejected is reported and writes nothing', async () => {
  mockSubmit.mockRejectedValue(new Error('TASK_SUBMISSION_NOT_ACKNOWLEDGED'));
  render(controls());
  await start();
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      'TASK_SUBMISSION_NOT_ACKNOWLEDGED',
    ),
  );
  expect(invoke).not.toHaveBeenCalledWith('setSettings', expect.anything());
  expect(defaultsWrites()).toEqual([]);
});

test('editing the draft never writes defaults through the controls', async () => {
  const view = render(controls());
  await screen.findByRole('button', { name: 'home:startTask' });
  view.rerender(controls({}, { ...draft, maxContext: 9 }));
  expect(defaultsWrites()).toEqual([]);
});

test.each([
  ['by default the start may ask about embedded subtitles', {}, true],
  [
    'a page whose configuration is pinned never asks: the stored snapshot wins in the main process',
    { promptEmbeddedSubtitles: false },
    false,
  ],
])('%s', async (_label, props, expected) => {
  render(controls(props));
  await start();
  await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
  expect(mockSubmit.mock.calls[0][1]).toEqual({
    promptEmbeddedSubtitles: expected,
  });
});
