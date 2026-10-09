import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import SuppressedBackends from '../settings/gpu/SuppressedBackends';
import type { SuppressedBackendInfo } from '../../../types/diagnostics';

// 文案取自真实的英文文件：key 写错会在这里暴露，而不是把裸 key 展示给用户。
jest.mock('next-i18next', () => {
  const settings = require('../../public/locales/en/settings.json');
  const t = (key: string, vars: Record<string, unknown> = {}) => {
    const value = key
      .split('.')
      .reduce<any>((node, part) => node?.[part], settings);
    if (typeof value !== 'string') return `MISSING:${key}`;
    return value.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
      String(vars[name] ?? ''),
    );
  };
  return { useTranslation: () => ({ t }) };
});

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const VULKAN: SuppressedBackendInfo = {
  scope: 'candidate',
  key: 'builtin:vulkan',
  reason: 'crash',
  evidence: 'strong',
  since: 1,
  detail: 'access-violation (ACCESS_VIOLATION 0xC0000005)',
};
const CUDA_WEAK: SuppressedBackendInfo = {
  scope: 'candidate',
  key: 'userData:cuda:12.4.0',
  reason: 'crash',
  evidence: 'weak',
  since: 2,
};
const FAMILY: SuppressedBackendInfo = {
  scope: 'family',
  key: 'whisper-x64-prebuilt',
  reason: 'isa',
  evidence: 'strong',
  since: 3,
  detail: 'illegal-instruction (ILLEGAL_INSTRUCTION 0xC000001D)',
};

type Handlers = Record<string, (...args: any[]) => unknown>;

function setup(handlers: Handlers) {
  const invoke = jest.fn(async (channel: string, ...args: unknown[]) =>
    handlers[channel]?.(...args),
  );
  window.ipc = { invoke } as any;
  render(<SuppressedBackends />);
  return { invoke };
}

beforeEach(() => {
  (toast.success as jest.Mock).mockClear();
  (toast.error as jest.Mock).mockClear();
});

test('nothing is rendered when no backend is suppressed', async () => {
  const { invoke } = setup({ 'get-suppressed-backends': () => [] });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('get-suppressed-backends'),
  );
  await Promise.resolve();
  expect(screen.queryByTestId('suppressed-backends')).toBeNull();
});

test('a failing read renders nothing instead of an error', async () => {
  const { invoke } = setup({
    'get-suppressed-backends': () => {
      throw new Error('no handler');
    },
  });
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  await Promise.resolve();
  expect(screen.queryByTestId('suppressed-backends')).toBeNull();
});

test('lists each disabled backend with a human label and the reason', async () => {
  setup({ 'get-suppressed-backends': () => [VULKAN, CUDA_WEAK, FAMILY] });

  const box = await screen.findByTestId('suppressed-backends');
  expect(box).toHaveTextContent('Acceleration backends disabled automatically');
  expect(box).toHaveTextContent('Vulkan — it crashed the app while running');
  expect(box).toHaveTextContent(
    'CUDA 12.4.0 — it was in use both times the app ended abnormally in a row',
  );
  expect(box).toHaveTextContent(
    "Built-in speech recognition addons (Vulkan, CUDA, CPU) — this computer's CPU lacks an instruction set it needs",
  );
  expect(box).toHaveTextContent(
    'Crash type: access-violation (ACCESS_VIOLATION 0xC0000005)',
  );
  // 弱证据那一项没有崩溃类型可显示
  expect(box.textContent).not.toContain('Crash type: undefined');
  expect(box.textContent).not.toContain('MISSING:');
});

test('retrying resets on the main side, clears the list and refreshes the acceleration badge', async () => {
  const { invoke } = setup({
    'get-suppressed-backends': () => [VULKAN],
    'reset-suppressed-backends': () => 1,
  });
  await screen.findByTestId('suppressed-backends');
  const changed = jest.fn();
  window.addEventListener('gpu-settings-changed', changed);

  fireEvent.click(
    screen.getByRole('button', { name: 'Retry disabled backends' }),
  );

  await waitFor(() =>
    expect(screen.queryByTestId('suppressed-backends')).toBeNull(),
  );
  window.removeEventListener('gpu-settings-changed', changed);
  expect(invoke).toHaveBeenCalledWith('reset-suppressed-backends');
  expect(toast.success).toHaveBeenCalledWith(
    'Reset. These backends will be tried again on the next transcription.',
  );
  expect(changed).toHaveBeenCalledTimes(1);
});

test('a failed reset keeps the list, tells the user why, and does not announce success', async () => {
  setup({
    'get-suppressed-backends': () => [VULKAN],
    'reset-suppressed-backends': () => {
      throw new Error('disk full');
    },
  });
  await screen.findByTestId('suppressed-backends');

  fireEvent.click(
    screen.getByRole('button', { name: 'Retry disabled backends' }),
  );

  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Reset failed: disk full'),
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.getByTestId('suppressed-backends')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Retry disabled backends' }),
  ).toBeEnabled();
});
