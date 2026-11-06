import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useTaskSubmission } from '../useTaskSubmission';
import { getTaskTypeBySlug } from '../../lib/taskTypes';

/**
 * Before a start, a video that carries embedded text subtitles is worth one question:
 * use them, or transcribe. These tests drive the real submission hook and the real
 * dialog; only the IPC is replaced, with a log of the calls so order can be asserted.
 */
const mockRequestConsent = jest.fn(async (..._args: unknown[]) => true);

jest.mock('next-i18next', () => {
  const strings: Record<string, string> = {
    'home:embeddedPrompt.trackSeparator': ', ',
    'home:embeddedPrompt.unknownLanguage': 'Unknown language',
    'home:embeddedPrompt.moreTracks': ', and {{count}} more',
  };
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        strings[key]
          ? strings[key].replace(/\{\{(\w+)\}\}/g, (_m, name) =>
              String(options?.[name]),
            )
          : options
            ? `${key}${JSON.stringify(options)}`
            : key,
      i18n: { language: 'en' },
    }),
  };
});
jest.mock('../useTaskCloudConsent', () => ({
  useTaskCloudConsent: () => ({
    requestConsent: (...args: unknown[]) => mockRequestConsent(...args),
    dialog: null,
  }),
}));

const USE = 'home:embeddedPrompt.useTitle';
const ASR = 'home:embeddedPrompt.asrTitle';
const REMEMBER = 'home:embeddedPrompt.remember';

const hit = {
  filePath: '/media/lesson 1.mkv',
  tracks: [
    { language: 'eng', codec: 'subrip' },
    { language: 'chi', codec: 'ass' },
  ],
};
const found = { status: 'found', hit, checked: 1, candidates: 3, elapsedMs: 4 };
const none = { status: 'none', checked: 3, candidates: 3, elapsedMs: 9 };

let api: ReturnType<typeof useTaskSubmission>;
function Harness() {
  api = useTaskSubmission();
  return <>{api.dialog}</>;
}

interface Ipc {
  settings?: Record<string, unknown>;
  scan?: (payload: unknown) => unknown;
  systemInfo?: () => unknown;
  updateTaskDefaults?: (patch: unknown) => unknown;
  submitTask?: (payload: any) => unknown;
}
let calls: Array<[string, any]>;
const called = (channel: string) =>
  calls.filter(([name]) => name === channel).map(([, payload]) => payload);
const order = () => calls.map(([name]) => name);

function installIpc({
  settings = {},
  scan = () => none,
  systemInfo = () => ({ modelsInstalled: ['base'] }),
  updateTaskDefaults = () => ({ success: true }),
  submitTask = (payload) => ({
    success: true,
    projectId: payload.projectId,
    requestId: payload.requestId,
    acceptedFileUuids: payload.files.map((file: any) => file.uuid),
    duplicate: false,
  }),
}: Ipc = {}) {
  calls = [];
  window.ipc = {
    invoke: jest.fn(async (channel: string, payload?: unknown) => {
      calls.push([channel, payload]);
      switch (channel) {
        case 'getSystemInfo':
          return systemInfo();
        case 'getTranslationProviders':
        case 'getAsrProviders':
          return [];
        case 'getSettings':
          return settings;
        case 'checkFileExists':
          return { exists: true };
        case 'findEmbeddedSubtitles':
          return scan(payload);
        case 'updateTaskDefaults':
          return updateTaskDefaults(payload);
        case 'setSettings':
          return { rejectedKeys: [] };
        case 'submitTask':
          return submitTask(payload);
        default:
          throw new Error(`Unexpected IPC ${channel}`);
      }
    }),
    send: jest.fn(),
    on: jest.fn(() => jest.fn()),
  } as any;
}

const generate = getTaskTypeBySlug('generate')!;
const translate = getTaskTypeBySlug('translate')!;
const media = (name: string, extra: Record<string, unknown> = {}) => ({
  uuid: name,
  filePath: `/media/${name}`,
  fileName: name,
  ...extra,
});
function makeInput(overrides: Record<string, any> = {}) {
  return {
    projectId: 'project',
    files: [media('lesson 1.mkv'), media('lesson 2.mp4')] as any,
    typeDef: generate,
    formData: {
      taskType: 'generateOnly' as const,
      transcriptionEngine: 'builtin',
      model: 'base',
    },
    ...overrides,
  };
}

function begin(
  input = makeInput(),
  options?: { promptEmbeddedSubtitles?: boolean },
) {
  let outcome!: ReturnType<typeof api.submit>;
  act(() => {
    outcome = api.submit(input, options);
  });
  return outcome;
}
const dialog = () => screen.findByRole('alertdialog');
const click = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
/** Wait for a start to finish, inside act: it moves the hook through several phases. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let result!: T;
  await act(async () => {
    result = await promise;
  });
  return result;
}

let view: ReturnType<typeof render>;
beforeEach(() => {
  installIpc();
  mockRequestConsent.mockImplementation(async () => true);
  view = render(<Harness />);
});

describe('asking', () => {
  test('names the file and its tracks, and holds the task until the answer', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    const open = await dialog();
    expect(open).toHaveTextContent('lesson 1.mkv');
    expect(open).toHaveTextContent('English · SubRip, Chinese · ASS');
    expect(called('submitTask')).toEqual([]);
    expect(api.starting).toBe(true);
    await click(USE);
    expect((await settle(outcome)).status).toBe('accepted');
  });

  test('probes the pending files, not the paired or subtitle ones', async () => {
    installIpc({ scan: () => found });
    const outcome = begin(
      makeInput({
        files: [
          media('a.mkv'),
          media('b.mp4', { providedSubtitlePath: '/media/b.srt' }),
          media('c.srt'),
        ],
      }),
    );
    await dialog();
    expect(called('findEmbeddedSubtitles')).toEqual([
      { filePaths: ['/media/a.mkv'] },
    ]);
    await click(USE);
    await settle(outcome);
  });

  test('summarises a long track list instead of listing every track', async () => {
    installIpc({
      scan: () => ({
        ...found,
        hit: {
          filePath: '/media/many.mkv',
          tracks: ['eng', 'chi', 'jpn', 'fre', 'ger'].map((language) => ({
            language,
            codec: 'subrip',
          })),
        },
      }),
    });
    const outcome = begin();
    const open = await dialog();
    expect(open).toHaveTextContent(
      'English · SubRip, Chinese · SubRip, Japanese · SubRip, and 2 more',
    );
    await click(USE);
    await settle(outcome);
  });

  test('says so when a track has no language', async () => {
    installIpc({
      scan: () => ({
        ...found,
        hit: { filePath: '/media/x.mkv', tracks: [{ codec: 'mov_text' }] },
      }),
    });
    const outcome = begin();
    expect(await dialog()).toHaveTextContent('Unknown language · MOV Text');
    await click(USE);
    await settle(outcome);
  });
});

describe('the answer applies to this task only', () => {
  test('use: the payload says so, nothing is written, the form input is untouched', async () => {
    installIpc({ scan: () => found });
    const input = makeInput();
    const outcome = begin(input);
    await dialog();
    await click(USE);
    const result: any = await settle(outcome);
    expect(result.status).toBe('accepted');
    expect(called('submitTask')[0].formData.useEmbeddedSubtitles).toBe(true);
    expect(result.snapshot.useEmbeddedSubtitles).toBe(true);
    expect(called('updateTaskDefaults')).toEqual([]);
    expect(called('setSettings')).toEqual([]);
    expect(input.formData).not.toHaveProperty('useEmbeddedSubtitles');
  });

  test('asr: the payload forces recognition, nothing is written', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    await click(ASR);
    const result: any = await settle(outcome);
    expect(result.status).toBe('accepted');
    expect(called('submitTask')[0].formData.useEmbeddedSubtitles).toBe(false);
    expect(result.snapshot.useEmbeddedSubtitles).toBe(false);
    expect(called('updateTaskDefaults')).toEqual([]);
    expect(called('setSettings')).toEqual([]);
  });

  test('cancel: nothing is submitted or written and the button is free again', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    await click('common:cancel');
    expect((await settle(outcome)).status).toBe('cancelled');
    expect(called('submitTask')).toEqual([]);
    expect(called('updateTaskDefaults')).toEqual([]);
    expect(called('setSettings')).toEqual([]);
    expect(api.starting).toBe(false);
    expect(api.phase).toBe('idle');
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
  });

  test('escape cancels too', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('alertdialog'), {
        key: 'Escape',
        code: 'Escape',
      });
    });
    expect((await settle(outcome)).status).toBe('cancelled');
    expect(called('submitTask')).toEqual([]);
  });

  test('closing the page while the question is open cancels without a task', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    view.unmount();
    expect((await settle(outcome)).status).toBe('cancelled');
    expect(called('submitTask')).toEqual([]);
  });

  test('escape while a remembered choice is being stored does not drop the task', async () => {
    let finishWrite!: () => void;
    installIpc({
      scan: () => found,
      updateTaskDefaults: () =>
        new Promise((resolve) => {
          finishWrite = () => resolve({ success: true });
        }),
    });
    const outcome = begin();
    await dialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: REMEMBER }));
    });
    await click(USE);
    await waitFor(() => expect(called('updateTaskDefaults')).toHaveLength(1));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('alertdialog'), {
        key: 'Escape',
        code: 'Escape',
      });
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await act(async () => finishWrite());
    expect((await settle(outcome)).status).toBe('accepted');
    expect(called('submitTask')[0].formData.useEmbeddedSubtitles).toBe(true);
  });
});

describe('remember my choice', () => {
  test.each([
    ['use', USE, true],
    ['asr', ASR, false],
  ])(
    'ticked, %s writes the default and switches the prompt off, in that order, before the task',
    async (_name, button, value) => {
      installIpc({ scan: () => found });
      const outcome = begin();
      await dialog();
      await act(async () => {
        fireEvent.click(screen.getByRole('checkbox', { name: REMEMBER }));
      });
      await click(button);
      expect((await settle(outcome)).status).toBe('accepted');
      expect(called('updateTaskDefaults')).toEqual([
        { useEmbeddedSubtitles: value },
      ]);
      expect(called('setSettings')).toEqual([
        { embeddedSubtitlePrompt: false },
      ]);
      expect(called('submitTask')[0].formData.useEmbeddedSubtitles).toBe(value);
      const channels = order();
      expect(channels.indexOf('updateTaskDefaults')).toBeLessThan(
        channels.indexOf('setSettings'),
      );
      expect(channels.indexOf('setSettings')).toBeLessThan(
        channels.indexOf('submitTask'),
      );
    },
  );

  test('the box starts unticked', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    expect(screen.getByRole('checkbox', { name: REMEMBER })).not.toBeChecked();
    await click(USE);
    await settle(outcome);
  });

  test('ticked and then cancelled remembers nothing', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: REMEMBER }));
    });
    await click('common:cancel');
    expect((await settle(outcome)).status).toBe('cancelled');
    expect(called('updateTaskDefaults')).toEqual([]);
    expect(called('setSettings')).toEqual([]);
  });

  test('the next question starts unticked again', async () => {
    installIpc({ scan: () => found });
    let outcome = begin();
    await dialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: REMEMBER }));
    });
    await click('common:cancel');
    await settle(outcome);
    outcome = begin();
    await dialog();
    expect(screen.getByRole('checkbox', { name: REMEMBER })).not.toBeChecked();
    await click(USE);
    await settle(outcome);
  });

  test('a default that cannot be written keeps the prompt on, and the task still goes', async () => {
    installIpc({
      scan: () => found,
      updateTaskDefaults: () => {
        throw new Error('EACCES');
      },
    });
    const outcome = begin();
    await dialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: REMEMBER }));
    });
    await click(ASR);
    expect((await settle(outcome)).status).toBe('accepted');
    expect(called('setSettings')).toEqual([]);
    expect(called('submitTask')[0].formData.useEmbeddedSubtitles).toBe(false);
  });

  test('a double click writes once', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: REMEMBER }));
    });
    await act(async () => {
      const button = screen.getByRole('button', { name: USE });
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect((await settle(outcome)).status).toBe('accepted');
    expect(called('updateTaskDefaults')).toHaveLength(1);
    expect(called('submitTask')).toHaveLength(1);
  });
});

describe('not asking', () => {
  test.each([
    ['nothing found', () => none],
    ['the budget ran out', () => ({ ...none, status: 'unknown', checked: 1 })],
    [
      'the probe failed',
      () => {
        throw new Error('spawn failed');
      },
    ],
    ['a malformed answer', () => ({ status: 'found' })],
  ])('%s: the task starts without a question', async (_name, scan) => {
    installIpc({ scan });
    const outcome = begin();
    expect((await settle(outcome)).status).toBe('accepted');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(called('submitTask')).toHaveLength(1);
    expect(called('submitTask')[0].formData).not.toHaveProperty(
      'useEmbeddedSubtitles',
    );
  });

  test('a main process that never answers does not hold the start', async () => {
    jest.useFakeTimers();
    try {
      installIpc({ scan: () => new Promise(() => {}) });
      let outcome!: ReturnType<typeof api.submit>;
      act(() => {
        outcome = api.submit(makeInput());
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1600);
      });
      expect((await settle(outcome)).status).toBe('accepted');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    [
      'recognition is already forced',
      makeInput({
        formData: {
          taskType: 'generateOnly',
          transcriptionEngine: 'builtin',
          model: 'base',
          useEmbeddedSubtitles: false,
        },
      }),
      {},
    ],
    [
      'the prompt was switched off',
      makeInput(),
      { embeddedSubtitlePrompt: false },
    ],
    [
      'the task does not transcribe',
      makeInput({
        typeDef: translate,
        files: [media('a.srt')],
        formData: { taskType: 'translateOnly', translateProvider: '-1' },
      }),
      {},
    ],
    [
      'every file is a subtitle or already has one',
      makeInput({
        files: [
          media('a.srt'),
          media('b.mkv', { providedSubtitlePath: '/media/b.srt' }),
        ],
      }),
      {},
    ],
  ])('%s: nothing is probed', async (_name, input, settings) => {
    installIpc({ scan: () => found, settings });
    const outcome = begin(input as any);
    const result = await settle(outcome);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(called('findEmbeddedSubtitles')).toEqual([]);
    expect(['accepted', 'invalid']).toContain(result.status);
    if (result.status === 'accepted')
      expect(called('submitTask')).toHaveLength(1);
  });

  test('a retry never asks', async () => {
    installIpc({ scan: () => found });
    const outcome = begin(makeInput(), { promptEmbeddedSubtitles: false });
    expect((await settle(outcome)).status).toBe('accepted');
    expect(called('findEmbeddedSubtitles')).toEqual([]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(called('submitTask')[0].formData).not.toHaveProperty(
      'useEmbeddedSubtitles',
    );
  });
});

describe('how it fits into the start', () => {
  test('the probe runs while the configuration is still being validated', async () => {
    let release!: () => void;
    let firstValidation = true;
    installIpc({
      scan: () => found,
      // Only the first validation is slow; the one after the answer is not.
      systemInfo: () => {
        if (!firstValidation) return { modelsInstalled: ['base'] };
        firstValidation = false;
        return new Promise((resolve) => {
          release = () => resolve({ modelsInstalled: ['base'] });
        });
      },
    });
    const outcome = begin();
    await waitFor(() =>
      expect(called('findEmbeddedSubtitles')).toHaveLength(1),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await act(async () => release());
    await dialog();
    await click(USE);
    expect((await settle(outcome)).status).toBe('accepted');
  });

  test('a configuration that cannot start is reported without a question', async () => {
    installIpc({
      scan: () => found,
      systemInfo: () => ({ modelsInstalled: [] }),
    });
    const outcome = begin();
    const result: any = await settle(outcome);
    expect(result.status).toBe('invalid');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(called('submitTask')).toEqual([]);
  });

  test('the cloud upload confirmation comes after the answer, not before', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    expect(mockRequestConsent).not.toHaveBeenCalled();
    await click(ASR);
    await settle(outcome);
    expect(mockRequestConsent).toHaveBeenCalledTimes(1);
  });

  test('using the embedded subtitles does not waive the upload confirmation', async () => {
    // Files without embedded subtitles, and an extraction that falls back to speech
    // recognition, still upload audio: the confirmation is about that, not about the track.
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    await click(USE);
    await settle(outcome);
    expect(mockRequestConsent).toHaveBeenCalledTimes(1);
    expect(mockRequestConsent).toHaveBeenCalledWith(true, 'builtin');
  });

  test('cancelling the question never reaches the upload confirmation', async () => {
    installIpc({ scan: () => found });
    const outcome = begin();
    await dialog();
    await click('common:cancel');
    expect((await settle(outcome)).status).toBe('cancelled');
    expect(mockRequestConsent).not.toHaveBeenCalled();
  });

  test('a start the consent refuses is cancelled after the answer', async () => {
    installIpc({ scan: () => found });
    mockRequestConsent.mockImplementation(async () => false);
    const outcome = begin();
    await dialog();
    await click(USE);
    expect((await settle(outcome)).status).toBe('cancelled');
    expect(called('submitTask')).toEqual([]);
  });

  test('the request identity follows the answer: same answer, same request', async () => {
    installIpc({
      scan: () => found,
      submitTask: () => {
        throw new Error('not acknowledged');
      },
    });
    const answers = [USE, USE, ASR];
    for (const answer of answers) {
      const outcome = begin();
      const failed = expect(outcome).rejects.toThrow('not acknowledged');
      await dialog();
      await click(answer);
      await act(async () => {
        await failed;
      });
    }
    const [first, second, third] = called('submitTask');
    expect(first.formData.useEmbeddedSubtitles).toBe(true);
    expect(third.formData.useEmbeddedSubtitles).toBe(false);
    expect(second.requestId).toBe(first.requestId);
    expect(third.requestId).not.toBe(first.requestId);
  });
});
