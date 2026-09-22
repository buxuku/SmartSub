import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { toast } from 'sonner';
import EngineModelTab from '../resources/EngineModelTab';

jest.mock('next-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context/NavigationGuardContext', () => ({
  useNavigationGuard: jest.fn(),
}));

let importRuntime: jest.Mock;
let settings: Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    'engineModelSelectedView',
    JSON.stringify('fasterWhisper'),
  );
  settings = { fasterWhisperDevice: 'cpu' };
  importRuntime = jest.fn();
  window.ipc = {
    on: jest.fn(() => jest.fn()),
    invoke: jest.fn(async (channel: string, payload: any) => {
      if (channel === 'import-py-engine') return importRuntime();
      if (channel === 'getSettings') return settings;
      if (channel === 'setSettings') {
        settings = { ...settings, ...payload };
        return { rejectedKeys: [] };
      }
      if (channel === 'getAsrProviders') return [];
      if (channel === 'get-engine-status')
        return { fasterWhisper: { state: 'ready', variant: 'cpu' } };
      if (channel === 'get-gpu-environment') return { platform: 'linux' };
      if (channel === 'getTaskStatus') return 'idle';
      if (channel === 'sherpa-lib-status') return { installed: true };
      if (channel.endsWith('ModelStatus'))
        return { success: true, ready: false };
      if (channel === 'getSystemInfo')
        return { modelsInstalled: [], downloadingModels: [], modelsPath: '' };
      return null;
    }),
  } as any;
});

async function startImport() {
  const button = await screen.findByRole('button', {
    name: 'engines.fasterWhisper.importRuntime',
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

test('CUDA runtime import saves automatic device selection through settings persistence', async () => {
  importRuntime.mockResolvedValue({ success: true, variant: 'cuda' });
  render(<EngineModelTab />);
  await startImport();
  await waitFor(() =>
    expect(window.ipc.invoke).toHaveBeenCalledWith('setSettings', {
      fasterWhisperDevice: 'auto',
    }),
  );
  expect(settings.fasterWhisperDevice).toBe('auto');
  expect(toast.success).toHaveBeenCalledWith(
    'engines.fasterWhisper.importSuccess',
  );
});

test('pending import blocks other engine operations and cancellation leaves settings untouched', async () => {
  let finish!: (result: unknown) => void;
  importRuntime.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<EngineModelTab />);
  await startImport();
  const importing = screen.getByRole('button', {
    name: 'engines.fasterWhisper.importing',
  });
  expect(importing).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'engines.fasterWhisper.uninstall' }),
  ).toBeDisabled();
  fireEvent.click(importing);
  expect(importRuntime).toHaveBeenCalledTimes(1);
  await act(async () => finish({ success: false, canceled: true }));
  expect(toast.success).not.toHaveBeenCalled();
  expect(settings.fasterWhisperDevice).toBe('cpu');
  expect(screen.queryByText('engines.operationFailed')).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'engines.fasterWhisper.importRuntime' }),
  ).toBeEnabled();
});

test('failed runtime import retains a retry action that can complete the import', async () => {
  importRuntime
    .mockResolvedValueOnce({ success: false, error: 'operation_in_progress' })
    .mockResolvedValueOnce({ success: true, variant: 'cpu' });
  render(<EngineModelTab />);
  await startImport();
  const retry = await screen.findByRole('button', {
    name: 'engines.operationRetry',
  });
  expect(screen.getByText('engines.operationFailed')).toBeVisible();
  fireEvent.click(retry);
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(importRuntime).toHaveBeenCalledTimes(2);
  expect(settings.fasterWhisperDevice).toBe('cpu');
  expect(screen.queryByText('engines.operationFailed')).not.toBeInTheDocument();
});

test('import completed after leaving the panel cannot save settings or announce success', async () => {
  let finish!: (result: unknown) => void;
  importRuntime.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { unmount } = render(<EngineModelTab />);
  await startImport();
  unmount();
  await act(async () => finish({ success: true, variant: 'cuda' }));
  expect(settings.fasterWhisperDevice).toBe('cpu');
  expect(toast.success).not.toHaveBeenCalled();
});
