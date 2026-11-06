import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { toast } from 'sonner';
import { useState } from 'react';
import useProviderPersistence from '../../hooks/useProviderPersistence';
import CloudProviderPanel from '../resources/engines/panels/CloudProviderPanel';
import TtsProviderPanel from '../tts/TtsProviderPanel';
import {
  ASR_PROVIDER_TYPES,
  buildCloudViews,
} from '../../../types/asrProvider';
import {
  TTS_PROVIDER_TYPES,
  TTS_ELEVENLABS,
  buildTtsViews,
} from '../../../types/ttsProvider';

jest.mock('../../context/NavigationGuardContext', () => ({
  useNavigationGuard: jest.fn(),
}));

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function props(tts = false) {
  const type = tts
    ? TTS_PROVIDER_TYPES.find((type) => type.id === TTS_ELEVENLABS)!
    : ASR_PROVIDER_TYPES[0];
  return {
    view: {
      viewId: 'test-view',
      kind: 'brand',
      type,
      instance: { id: 'test', type: type.id, name: 'Test', apiKey: 'key' },
    } as any,
    onUpdateField: jest.fn(),
    onMaterialize: jest.fn().mockReturnValue('created'),
    onRemove: jest.fn(),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  window.ipc = { invoke: jest.fn() } as any;
});

test.each([false, true])(
  'late connection result cannot appear on a different ASR/TTS panel (tts=%p)',
  async (tts) => {
    const Component = tts ? TtsProviderPanel : CloudProviderPanel;
    const pending = deferred();
    (window.ipc.invoke as jest.Mock).mockReturnValue(pending.promise);
    const input = props(tts);
    const { rerender } = render(<Component {...input} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'cloudAsr.testConnection' }),
    );
    rerender(
      <Component
        {...input}
        view={{
          ...input.view,
          viewId: 'other',
          instance: { ...input.view.instance, id: 'other' },
        }}
      />,
    );
    await act(async () => pending.resolve({ ok: true }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(input.onMaterialize).not.toHaveBeenCalled();
    expect(
      screen.queryByText(
        tts ? 'dubbingBlock.testSuccess' : 'cloudAsr.testSuccess',
      ),
    ).not.toBeInTheDocument();
  },
);

test.each([false, true])(
  'connection failure retains details and retry action (tts=%p)',
  async (tts) => {
    const Component = tts ? TtsProviderPanel : CloudProviderPanel;
    (window.ipc.invoke as jest.Mock)
      .mockRejectedValueOnce(new Error('ECONNREFUSED fixture'))
      .mockResolvedValue({ ok: true });
    render(<Component {...props(tts)} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'cloudAsr.testConnection' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'ECONNREFUSED fixture',
      ),
    );
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'cloudAsr.testConnection' })
        .at(-1)!,
    );
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    expect(window.ipc.invoke).toHaveBeenCalledTimes(2);
  },
);

test.each(['switch', 'edit', 'unmount'])(
  'late voice list after %s cannot overwrite or recreate a provider',
  async (action) => {
    const pending = deferred();
    (window.ipc.invoke as jest.Mock).mockReturnValue(pending.promise);
    const input = props(true);
    const { rerender, unmount } = render(<TtsProviderPanel {...input} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'ttsServices.fetchVoices' }),
    );
    if (action === 'unmount') unmount();
    else
      rerender(
        <TtsProviderPanel
          {...input}
          view={{
            ...input.view,
            viewId: action === 'switch' ? 'other' : input.view.viewId,
            instance: { ...input.view.instance, apiKey: 'changed' },
          }}
        />,
      );
    await act(async () =>
      pending.resolve({ ok: true, voices: [{ id: 'voice', name: 'Voice' }] }),
    );
    expect(input.onUpdateField).not.toHaveBeenCalled();
    expect(input.onMaterialize).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  },
);

test('voice list failure is persistent and explicit retry updates current fields', async () => {
  const input = props(true);
  (window.ipc.invoke as jest.Mock)
    .mockRejectedValueOnce(new Error('voice endpoint unavailable'))
    .mockResolvedValueOnce({
      ok: true,
      voices: [{ id: 'voice', name: 'Voice' }],
    });
  render(<TtsProviderPanel {...input} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'ttsServices.fetchVoices' }),
  );
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'voice endpoint unavailable',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'saveState.retry' }));
  await waitFor(() =>
    expect(input.onUpdateField).toHaveBeenCalledWith('test', 'voices', 'voice'),
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test.each([false, true])(
  'unblurred tag draft survives switching and saves with the latest provider (tts=%p)',
  async (tts) => {
    const initial = [
      {
        id: 'draft-test',
        name: 'Draft test',
        type: 'openaiCompatible',
        models: 'old',
        voices: 'old',
      },
    ];
    (window.ipc.invoke as jest.Mock).mockImplementation(
      async (channel: string) =>
        channel.startsWith('get') ? initial : { success: true },
    );
    function Harness() {
      const state = useProviderPersistence<any>(tts ? 'Tts' : 'Asr');
      const [visible, setVisible] = useState(true);
      const view = (
        tts ? buildTtsViews(state.providers) : buildCloudViews(state.providers)
      ).find((entry) => entry.instance?.id === 'draft-test');
      const Component = tts ? TtsProviderPanel : CloudProviderPanel;
      return (
        <>
          <span data-testid="dirty">{String(state.isDirty)}</span>
          <button onClick={() => setVisible(!visible)}>switch</button>
          <button onClick={() => void state.save()}>save</button>
          {view && visible && (
            <Component
              view={view as any}
              drafts={state}
              onUpdateField={(id, key, value) =>
                state.change((providers) =>
                  providers.map((provider) =>
                    provider.id === id
                      ? { ...provider, [key]: value }
                      : provider,
                  ),
                )
              }
              onMaterialize={() => null}
              onRemove={() => {}}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    const placeholder = tts
      ? 'ttsServices.voicesAddHint'
      : 'cloudAsr.modelsAddHint';
    fireEvent.change(await screen.findByPlaceholderText(placeholder), {
      target: { value: 'typed-not-blurred' },
    });
    expect(screen.getByTestId('dirty')).toHaveTextContent('true');
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(screen.getByPlaceholderText(placeholder)).toHaveValue(
      'typed-not-blurred',
    );
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(screen.getByTestId('dirty')).toHaveTextContent('false'),
    );
    const write = (window.ipc.invoke as jest.Mock).mock.calls.find(
      ([channel]) => channel.startsWith('set'),
    );
    expect(write[1].providers[0][tts ? 'voices' : 'models']).toBe(
      'old, typed-not-blurred',
    );
    expect(screen.getByPlaceholderText(placeholder)).toHaveValue('');
  },
);
