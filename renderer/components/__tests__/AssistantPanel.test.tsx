import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import AssistantPanel from '../assistant/AssistantPanel';
import type { AssistantSession } from '../../../types/assistant';
import type { AutomationJob } from '../../../types/automation';
import AssistantMarkdown from '../assistant/AssistantMarkdown';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { shortcut?: string }) =>
      key === 'assistant.inputHint'
        ? require('../../public/locales/en/common.json').assistant.inputHint.replace(
            '{{shortcut}}',
            options?.shortcut,
          )
        : key,
  }),
}));
jest.mock('next/router', () => ({
  useRouter: () => ({ query: { locale: 'en' }, push: jest.fn() }),
}));
jest.mock('../../context/AssistantContext', () => ({
  useAssistant: () => ({
    open: true,
    setOpen: mockSetOpen,
    capture: () => undefined,
    context: { page: '/en/translation' },
  }),
}));
const mockSetOpen = jest.fn();

const provider = {
  id: 'configured',
  name: 'Configured service',
  modelName: 'model',
};
const runningJob: AutomationJob = {
  id: 'submitted-job',
  operation: 'transcribe',
  status: 'running',
  createdAt: 1,
  updatedAt: 2,
  artifacts: [],
  actions: ['cancel'],
};
const completedJob: AutomationJob = {
  ...runningJob,
  status: 'completed',
  updatedAt: 3,
  artifacts: [{ kind: 'srt', path: '/output.srt' }],
  actions: [],
};
const session: AssistantSession = {
  id: 'session',
  title: 'Transcribe',
  providerId: provider.id,
  createdAt: 1,
  updatedAt: 2,
  status: 'interrupted',
  messages: [
    {
      id: 'message',
      turnId: 'turn',
      role: 'assistant',
      content: '',
      createdAt: 1,
      tools: [
        {
          id: 'call',
          name: 'smartsub_transcribe',
          arguments: '{}',
          status: 'interrupted',
          job: runningJob,
        },
      ],
    },
  ],
};
let invoke: jest.Mock;
let listeners: Map<string, (event: any) => void>;
beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  listeners = new Map();
  invoke = jest.fn(async (channel) => {
    if (channel === 'assistant:providers') return [provider];
    if (channel === 'assistant:list') return [session];
    if (channel === 'assistant:get') return structuredClone(session);
    if (channel === 'assistant:task') return completedJob;
    if (channel === 'assistant:start') return {};
    throw new Error(`Unexpected channel ${channel}`);
  });
  window.ipc = {
    invoke,
    send: jest.fn(),
    getPathForFile: (file: File) => `/files/${file.name}`,
    on: (channel: string, listener: (event: any) => void) => {
      listeners.set(channel, listener);
      return () => listeners.delete(channel);
    },
  } as any;
});
function publishJob(job: AutomationJob) {
  const next = structuredClone(session);
  next.messages[0].tools![0].job = job;
  act(() =>
    listeners.get('assistant:event')!({ type: 'session', session: next }),
  );
}

test.each([
  ['MacIntel', '⌘J'],
  ['Win32', 'Ctrl+J'],
])(
  'opening focuses the composer and shows the platform shortcut on %s',
  async (platform, shortcut) => {
    Object.defineProperty(navigator, 'platform', {
      value: platform,
      configurable: true,
    });
    render(<AssistantPanel />);
    await screen.findByTestId('assistant-tool');
    expect(screen.getByLabelText('assistant.input')).toHaveFocus();
    expect(
      screen.getByText(
        `Enter to send · Shift+Enter for a new line · ${shortcut} to toggle assistant`,
      ),
    ).toBeVisible();
  },
);

test('a completed polled task survives stale session snapshots after stopping the conversation', async () => {
  render(<AssistantPanel />);
  const card = await screen.findByTestId('assistant-tool');
  await waitFor(() =>
    expect(within(card).getByText('assistant.status.completed')).toBeVisible(),
  );
  publishJob({ ...runningJob });
  expect(within(card).getByText('assistant.status.completed')).toBeVisible();
  expect(within(card).getByText('output.srt')).toBeVisible();
  expect(
    within(card).queryByText('assistant.cancelTask'),
  ).not.toBeInTheDocument();
  // Coarse timestamps must not regress a terminal result either.
  publishJob({ ...runningJob, updatedAt: completedJob.updatedAt });
  expect(within(card).getByText('assistant.status.completed')).toBeVisible();
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'assistant:task'),
  ).toHaveLength(1);
});

test('a newer resumed task restarts polling even when its ID is unchanged', async () => {
  render(<AssistantPanel />);
  const card = await screen.findByTestId('assistant-tool');
  await waitFor(() =>
    expect(within(card).getByText('assistant.status.completed')).toBeVisible(),
  );
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (channel, ...args) =>
    channel === 'assistant:task'
      ? {
          ...completedJob,
          updatedAt: 5,
          artifacts: [{ kind: 'srt', path: '/resumed.srt' }],
        }
      : originalInvoke(channel, ...args),
  );
  publishJob({ ...runningJob, updatedAt: 4 });
  await waitFor(() =>
    expect(within(card).getByText('resumed.srt')).toBeVisible(),
  );
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'assistant:task'),
  ).toHaveLength(2);
});

test('provider save notifications refresh the open panel and enable sending', async () => {
  let configured = false;
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'assistant:providers') return configured ? [provider] : [];
    if (channel === 'assistant:list') return [];
    if (channel === 'assistant:create')
      return { ...session, messages: [], status: 'idle' };
    return originalInvoke(channel, ...args);
  });
  render(<AssistantPanel />);
  fireEvent.change(screen.getByLabelText('assistant.input'), {
    target: { value: 'List models' },
  });
  expect(screen.getByRole('button', { name: 'assistant.send' })).toBeDisabled();
  fireEvent.click(screen.getByText('assistant.configure'));
  configured = true;
  act(() =>
    listeners.get('assistant:event')!({
      type: 'changed',
      operation: 'providers.update',
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('assistant.service')).toHaveValue(provider.id),
  );
  expect(screen.getByRole('button', { name: 'assistant.send' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'assistant.send' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'assistant:start',
      expect.objectContaining({ providerId: provider.id, text: 'List models' }),
    ),
  );
});

test('a provider read started before configuration cannot overwrite the refreshed list', async () => {
  let resolveOld!: (value: any) => void;
  const old = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const originalInvoke = invoke.getMockImplementation()!;
  let reads = 0;
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'assistant:providers')
      return reads++ === 0 ? old : [provider];
    if (channel === 'assistant:list') return [];
    return originalInvoke(channel, ...args);
  });
  render(<AssistantPanel />);
  act(() =>
    listeners.get('assistant:event')!({
      type: 'changed',
      operation: 'providers.update',
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('assistant.service')).toHaveValue(provider.id),
  );
  await act(async () => resolveOld([]));
  expect(
    screen.getByRole('option', { name: 'Configured service · model' }),
  ).toBeVisible();
});

test('Markdown renders tables, lists and code without running HTML or loading remote images', () => {
  const { container } = render(
    <AssistantMarkdown>
      {
        '# Heading\n\n**Bold**\n\n- One\n- Two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n![tracker](https://example.com/pixel)\n\n[Unsafe](javascript:alert(1))\n\n[Docs](https://example.com/docs)'
      }
    </AssistantMarkdown>,
  );
  expect(screen.getByRole('heading', { name: 'Heading' })).toBeVisible();
  expect(screen.getByRole('table')).toBeVisible();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(container.querySelector('pre code')).toHaveTextContent('const x = 1;');
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  expect(
    screen.queryByRole('link', { name: 'Unsafe' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Docs' }));
  expect(window.ipc.send).toHaveBeenCalledWith(
    'openUrl',
    'https://example.com/docs',
  );
});

test('history is collapsed by default, opens on the left and closes after selection', async () => {
  render(<AssistantPanel />);
  await screen.findByTestId('assistant-tool');
  expect(
    screen.queryByTestId('assistant-history-overlay'),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'assistant.history' }));
  const history = screen.getByTestId('assistant-history-overlay');
  fireEvent.click(within(history).getByRole('button', { name: /^Transcribe/ }));
  expect(
    screen.queryByTestId('assistant-history-overlay'),
  ).not.toBeInTheDocument();
  await screen.findByTestId('assistant-tool');
  expect(mockSetOpen).not.toHaveBeenCalled();
});

test('delete a history entry without selecting it or losing the current draft', async () => {
  const other = { ...session, id: 'other', title: 'Older chat', messages: [] };
  let history = [session, other];
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'assistant:list') return history;
    if (channel === 'assistant:delete') {
      history = history.filter((item) => item.id !== args[0].id);
      return true;
    }
    return originalInvoke(channel, ...args);
  });
  render(<AssistantPanel />);
  await screen.findByTestId('assistant-tool');
  fireEvent.change(screen.getByLabelText('assistant.input'), {
    target: { value: 'Keep my draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'assistant.history' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'assistant.delete · Older chat' }),
  );
  expect(invoke).not.toHaveBeenCalledWith('assistant:get', { id: other.id });
  fireEvent.click(screen.getByRole('button', { name: 'assistant.delete' }));
  await waitFor(() =>
    expect(screen.queryByText('Older chat')).not.toBeInTheDocument(),
  );
  expect(invoke).toHaveBeenCalledWith('assistant:delete', { id: other.id });
  expect(screen.getByTestId('assistant-history-overlay')).toBeVisible();
  expect(screen.getByLabelText('assistant.input')).toHaveValue('Keep my draft');
  expect(localStorage.getItem('assistant:lastSession')).toBe(session.id);
  expect(screen.getByTestId('assistant-tool')).toBeInTheDocument();
});

test('deleting the selected chat clears its draft while keeping history open', async () => {
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (channel, ...args) =>
    channel === 'assistant:delete' ? true : originalInvoke(channel, ...args),
  );
  render(<AssistantPanel />);
  await screen.findByTestId('assistant-tool');
  fireEvent.change(screen.getByLabelText('assistant.input'), {
    target: { value: 'Draft belonging to the deleted chat' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'assistant.history' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'assistant.delete · Transcribe' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'assistant.delete' }));
  await screen.findByText('assistant.emptyHistory');
  expect(localStorage.getItem('assistant:lastSession')).toBeNull();
  expect(screen.getByLabelText('assistant.input')).toHaveValue('');
  expect(screen.queryByTestId('assistant-tool')).not.toBeInTheDocument();
  expect(screen.getByTestId('assistant-history-overlay')).toBeVisible();
});

test('history deletion can be cancelled, reports failures inline, and protects running chats', async () => {
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'assistant:list')
      return [
        session,
        { ...session, id: 'busy', title: 'Running chat', status: 'running' },
      ];
    if (channel === 'assistant:delete') throw new Error('Delete failed');
    return originalInvoke(channel, ...args);
  });
  render(<AssistantPanel />);
  await screen.findByTestId('assistant-tool');
  fireEvent.click(screen.getByRole('button', { name: 'assistant.history' }));
  expect(
    screen.getByRole('button', { name: 'assistant.delete · Running chat' }),
  ).toBeDisabled();
  const remove = screen.getByRole('button', {
    name: 'assistant.delete · Transcribe',
  });
  fireEvent.click(remove);
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
  expect(invoke).not.toHaveBeenCalledWith(
    'assistant:delete',
    expect.anything(),
  );
  fireEvent.click(remove);
  fireEvent.click(screen.getByRole('button', { name: 'assistant.delete' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed');
  expect(remove).toBeEnabled();
  expect(localStorage.getItem('assistant:lastSession')).toBe(session.id);
});

test('outside clicks dismiss the panel while panel and toggle clicks keep it open; keyboard resize persists', async () => {
  render(<AssistantPanel />);
  await screen.findByTestId('assistant-tool');
  fireEvent.click(screen.getByTestId('assistant-panel'));
  expect(mockSetOpen).not.toHaveBeenCalled();
  const toggle = document.createElement('button');
  toggle.setAttribute('data-assistant-toggle', '');
  document.body.append(toggle);
  fireEvent.click(toggle);
  expect(mockSetOpen).not.toHaveBeenCalled();
  toggle.remove();
  const resize = screen.getByRole('separator', { name: 'assistant.resize' });
  fireEvent.keyDown(resize, { key: 'ArrowLeft' });
  expect(screen.getByTestId('assistant-panel')).toHaveStyle({ width: '464px' });
  expect(localStorage.getItem('assistant:width')).toBe('464');
  fireEvent.click(document.body);
  expect(mockSetOpen).toHaveBeenCalledWith(false);
});

test.each([
  { name: 'notes.md', kind: 'file' },
  { name: 'movie.mp4', kind: 'video' },
  { name: 'recording.wav', kind: 'audio' },
])(
  'dropped $kind files send independently of workspace and remain in draft after a failed send',
  async (file) => {
    const attachment = {
      id: 'file-id',
      ...file,
      path: `/files/${file.name}`,
      size: 12,
    };
    const originalInvoke = invoke.getMockImplementation()!;
    let fail = true;
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'assistant:attachments')
        return { attachments: [attachment], errors: [] };
      if (channel === 'assistant:start') {
        if (fail) throw new Error('Offline');
        return {};
      }
      return originalInvoke(channel, ...args);
    });
    render(<AssistantPanel />);
    await screen.findByTestId('assistant-tool');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.drop(screen.getByTestId('assistant-panel'), {
      dataTransfer: {
        files: [new File(['File notes'], file.name)],
        types: ['Files'],
      },
    });
    await screen.findByTestId('assistant-attachment');
    expect(invoke).toHaveBeenCalledWith('assistant:attachments', {
      paths: [`/files/${file.name}`],
    });
    fireEvent.click(screen.getByRole('button', { name: 'assistant.send' }));
    await screen.findByText('Error: Offline');
    expect(screen.getByTestId('assistant-attachment')).toHaveTextContent(
      file.name,
    );
    expect(screen.getByTestId('assistant-attachment')).toHaveTextContent(
      `assistant.attachmentKind.${file.kind}`,
    );
    expect(invoke).toHaveBeenCalledWith(
      'assistant:start',
      expect.objectContaining({
        attachmentIds: ['file-id'],
        context: undefined,
        text: 'assistant.analyzeAttachments',
      }),
    );
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'assistant.send' }));
    await waitFor(() =>
      expect(
        screen.queryByTestId('assistant-attachment'),
      ).not.toBeInTheDocument(),
    );
  },
);

test('clicking screen capture button captures workspace screen and attaches it to draft attachments', async () => {
  const attachment = {
    id: 'screenshot-id',
    name: 'screenshot-123.jpg',
    path: '/path/to/screenshot-123.jpg',
    size: 2048,
    kind: 'image',
    imagePath: '/path/to/screenshot-123.jpg',
    mimeType: 'image/jpeg',
  };
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'assistant:capture-screen') return attachment;
    return originalInvoke(channel, ...args);
  });
  render(<AssistantPanel />);
  await screen.findByTestId('assistant-tool');
  const captureBtn = screen.getByRole('button', {
    name: 'assistant.captureScreen',
  });
  fireEvent.click(captureBtn);
  await screen.findByTestId('assistant-attachment');
  expect(invoke).toHaveBeenCalledWith('assistant:capture-screen', {
    region: 'workspace',
  });
  expect(screen.getByTestId('assistant-attachment')).toHaveTextContent(
    'screenshot-123.jpg',
  );
});
