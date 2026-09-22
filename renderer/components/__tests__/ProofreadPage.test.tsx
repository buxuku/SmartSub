import React, { StrictMode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import ProofreadPage from '../../pages/[locale]/proofread';
import { toast } from 'sonner';

const mockRouter = {
  isReady: true,
  query: {} as Record<string, any>,
  push: jest.fn(),
};
const mockUndo: Array<() => void> = [];
const mockConfirm = (_message: string, undo: () => void) => {
  mockUndo.push(undo);
};
const mockTranslate = (key: string) => key;
jest.mock('next/router', () => ({ useRouter: () => mockRouter }));
jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}));
jest.mock('../../lib/get-static', () => ({
  getStaticPaths: jest.fn(),
  makeStaticProperties: jest.fn(),
}));
jest.mock('../../hooks/useConfirmOrUndo', () => ({
  useConfirmOrUndo: () => mockConfirm,
}));
jest.mock('../../context/NavigationGuardContext', () => ({
  useNavigationGuard: jest.fn(),
}));
jest.mock('sonner', () => ({ toast: { error: jest.fn() } }));
jest.mock('../proofread/ProofreadEditor', () => () => <div>editor</div>);
jest.mock('../proofread/ProofreadImport', () => ({ onImportComplete }: any) => (
  <button
    onClick={() =>
      onImportComplete(
        [
          {
            id: 'new',
            fileName: 'New',
            selectedSource: '/New.srt',
            detectedSubtitles: [],
            status: 'pending',
          },
        ],
        'subtitle',
      )
    }
  >
    Import new
  </button>
));
jest.mock('../proofread/ProofreadFileList', () => (props: any) => (
  <div>
    <h2>{props.taskName}</h2>
    <input
      aria-label="Task name"
      value={props.taskName}
      onChange={(e) => props.onTaskNameChange(e.target.value)}
    />
    <output>
      {JSON.stringify({
        id: props.savedTaskId,
        dirty: props.isDirty,
        status: props.saveStatus,
        files: props.files,
      })}
    </output>
    <button onClick={props.onSaveTask}>Save</button>
    <button onClick={props.onReset}>Reset</button>
    <button onClick={() => props.onRemoveFile(0)}>Remove</button>
  </div>
));

const task = (id: string, scan = false) => ({
  id,
  name: `Task ${id}`,
  items: [
    {
      id: `${id}-item`,
      sourceSubtitlePath: `/${id}/source.srt`,
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      status: 'in_progress',
      ...(scan
        ? {}
        : {
            detectedSubtitles: [
              {
                filePath: `/${id}/source.srt`,
                type: 'source',
                confidence: 100,
              },
            ],
          }),
    },
  ],
});
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (reason: any) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let invoke: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  mockUndo.length = 0;
  mockRouter.query = { locale: 'zh', workItem: 'A' };
  invoke = jest.fn(async (channel: string, payload: any) => {
    if (channel === 'getProofreadTaskById')
      return { success: true, data: task(payload.id) };
    if (channel === 'getUserConfig')
      return { sourceLanguage: 'zh', targetLanguage: 'en' };
    if (channel === 'scanDirectorySubtitles')
      return { success: true, data: [] };
    if (channel === 'detectLanguage')
      return { success: true, data: { code: 'en' } };
    if (channel === 'detectSubtitles')
      return { success: true, data: { detectedSubtitles: [] } };
    if (channel === 'checkFileExists') return { exists: true };
    if (channel === 'updateProofreadTask')
      return { success: true, data: { id: payload.taskId } };
    if (channel === 'createProofreadTask')
      return { success: true, data: { id: 'created' } };
    throw new Error(channel);
  });
  window.ipc = { invoke } as any;
});
const state = () => JSON.parse(document.querySelector('output')!.textContent!);
const expectTask = async (name: string) => {
  await waitFor(() =>
    expect(screen.getByRole('heading', { name })).toBeVisible(),
  );
};

test.each([
  { success: false, error: 'Disk unreadable' },
  undefined,
  { success: true },
  { success: true, data: { id: 'wrong', name: 'Wrong', items: [] } },
  { success: true, data: { ...task('A'), items: [null] } },
  {
    success: true,
    data: { ...task('A'), items: [task('A').items[0], task('A').items[0]] },
  },
])(
  'load failure remains blocked until explicit retry: %j',
  async (response) => {
    const normal = invoke.getMockImplementation()!;
    let failed = true;
    invoke.mockImplementation((channel, payload) =>
      channel === 'getProofreadTaskById' && failed
        ? Promise.resolve(response)
        : normal(channel, payload),
    );
    render(<ProofreadPage />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'proofreadBatchLoad.failed',
      ),
    );
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.queryByText('Import new')).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
    failed = false;
    fireEvent.click(
      screen.getByRole('button', { name: 'proofreadLoad.retry' }),
    );
    await expectTask('Task A');
    expect(state()).toMatchObject({ dirty: false, id: 'A' });
    expect(state().files[0].status).toBe('proofreading');
  },
);

test.each([false, true])(
  'late nested batch read cannot replace a new route (reject: %s)',
  async (reject) => {
    const pending = deferred();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) => {
      if (channel === 'getProofreadTaskById' && payload.id === 'A')
        return Promise.resolve({ success: true, data: task('A', true) });
      if (
        channel === 'scanDirectorySubtitles' &&
        payload.directoryPath === '/A'
      )
        return pending.promise;
      return normal(channel, payload);
    });
    const view = render(<ProofreadPage />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('scanDirectorySubtitles', {
        directoryPath: '/A',
        strict: true,
      }),
    );
    mockRouter.query = { locale: 'zh', workItem: 'B' };
    view.rerender(<ProofreadPage />);
    await expectTask('Task B');
    await act(async () => {
      reject
        ? pending.reject(new Error('Old scan rejected'))
        : pending.resolve({ success: true, data: [] });
    });
    expect(screen.getByRole('heading')).toHaveTextContent('Task B');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(state().id).toBe('B');
  },
);

test('malformed nested scan response blocks, retry uses project languages and preserves status', async () => {
  const normal = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((channel, payload) => {
    if (channel === 'getProofreadTaskById')
      return Promise.resolve({ success: true, data: task('A', true) });
    if (channel === 'scanDirectorySubtitles')
      return Promise.resolve(
        failed
          ? { success: true, data: 'wrong' }
          : { success: true, data: ['/A/other.en.srt'] },
      );
    return normal(channel, payload);
  });
  render(<ProofreadPage />);
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'INVALID_SUBTITLE_SCAN_RESPONSE',
    ),
  );
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'proofreadLoad.retry' }));
  await expectTask('Task A');
  expect(state().files[0].detectedSubtitles[0].type).toBe('source');
});

test('file links deduplicate inputs and a missing file is recoverable without a partial batch', async () => {
  mockRouter.query = {
    locale: 'zh',
    file: ['/one.srt', '/two.srt', '/one.srt'],
  };
  const normal = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((channel, payload) =>
    channel === 'checkFileExists' && payload.filePath === '/two.srt'
      ? Promise.resolve({ exists: !failed })
      : normal(channel, payload),
  );
  render(<ProofreadPage />);
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'File not found: /two.srt',
    ),
  );
  expect(screen.queryByText('Save')).not.toBeInTheDocument();
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'proofreadLoad.retry' }));
  await expectTask('one');
  expect(state().files).toHaveLength(2);
  expect(state().dirty).toBe(true);
});

test('conflicting link blocks without IPC and offers a clean import route', async () => {
  mockRouter.query = { locale: 'en', workItem: 'A', file: '/file.srt' };
  render(<ProofreadPage />);
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'proofreadBatchLoad.invalidLink',
    ),
  );
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'proofreadBatchLoad.back' }),
  );
  expect(mockRouter.push).toHaveBeenCalledWith('/en/proofread/');
});

test('StrictMode and equivalent query arrays do not reload a dirty workspace', async () => {
  mockRouter.query = { locale: 'zh', file: ['/one.srt'] };
  const view = render(
    <StrictMode>
      <ProofreadPage />
    </StrictMode>,
  );
  await expectTask('one');
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Dirty name' },
  });
  const reads = invoke.mock.calls.length;
  mockRouter.query = { locale: 'zh', file: ['/one.srt'] };
  view.rerender(
    <StrictMode>
      <ProofreadPage />
    </StrictMode>,
  );
  expect(invoke).toHaveBeenCalledTimes(reads);
  expect(state().dirty).toBe(true);
  expect(screen.getByRole('heading')).toHaveTextContent('Dirty name');
});

test.each([false, true])(
  'late save after reset cannot mutate or unlock a new save (reject: %s)',
  async (reject) => {
    const old = deferred();
    const next = deferred();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === 'updateProofreadTask'
        ? old.promise
        : channel === 'createProofreadTask'
          ? next.promise
          : normal(channel, payload),
    );
    render(<ProofreadPage />);
    await expectTask('Task A');
    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(screen.getByText('Reset'));
    fireEvent.click(screen.getByText('Import new'));
    fireEvent.click(screen.getByText('Save'));
    await act(async () => {
      reject
        ? old.reject(new Error('Old save rejected'))
        : old.resolve({ success: true, data: { id: 'A' } });
    });
    expect(state()).toMatchObject({ id: null, status: 'saving', dirty: true });
    fireEvent.click(screen.getByText('Save'));
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === 'createProofreadTask',
      ),
    ).toHaveLength(1);
    act(() => mockUndo[0]());
    expect(screen.getByRole('heading')).toHaveTextContent('New');
    await act(async () =>
      next.resolve({ success: true, data: { id: 'created' } }),
    );
    expect(state()).toMatchObject({
      id: 'created',
      status: 'saved',
      dirty: false,
    });
    expect(toast.error).not.toHaveBeenCalled();
  },
);

test('late route save and old remove undo cannot resurrect a different project', async () => {
  const old = deferred();
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'updateProofreadTask' ? old.promise : normal(channel, payload),
  );
  const view = render(<ProofreadPage />);
  await expectTask('Task A');
  fireEvent.click(screen.getByText('Remove'));
  fireEvent.click(screen.getByText('Save'));
  mockRouter.query = { locale: 'zh', workItem: 'B' };
  view.rerender(<ProofreadPage />);
  await expectTask('Task B');
  await act(async () => old.resolve({ success: true, data: { id: 'A' } }));
  act(() => mockUndo[0]());
  expect(state()).toMatchObject({ id: 'B', dirty: false, status: 'idle' });
  expect(state().files).toHaveLength(1);
});
