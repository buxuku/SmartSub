import { render, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { PreviousRunNoticeToast } from '../diagnostics/PreviousRunNoticeToast';
import type { PreviousRunNotice } from '../../../types/diagnostics';

// 文案取自真实的英文文件：key 写错会在这里暴露，而不是把裸 key 展示给用户。
jest.mock('next-i18next', () => {
  const common = require('../../public/locales/en/common.json');
  const t = (key: string, vars: Record<string, unknown> = {}) => {
    const value = key
      .split('.')
      .reduce<any>((node, part) => node?.[part], common);
    if (typeof value !== 'string') return `MISSING:${key}`;
    return value.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
      String(vars[name] ?? ''),
    );
  };
  return { useTranslation: () => ({ t }) };
});

jest.mock('sonner', () => ({ toast: { warning: jest.fn() } }));

const warning = toast.warning as unknown as jest.Mock;

function setup(notice: PreviousRunNotice | null) {
  const invoke = jest.fn(async (channel: string) =>
    channel === 'crash:previous-run-notice' ? notice : true,
  );
  window.ipc = { invoke } as any;
  const view = render(<PreviousRunNoticeToast />);
  return { invoke, view };
}

beforeEach(() => warning.mockClear());

test('no evidence means no toast and nothing to acknowledge', async () => {
  const { invoke } = setup(null);

  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('crash:previous-run-notice'),
  );
  await Promise.resolve();

  expect(warning).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith('crash:dismiss-previous-run-notice');
});

test('a notice shows once, names the fault, and is acknowledged right away', async () => {
  const { invoke } = setup({
    at: 1,
    evidence: ['dump'],
    kind: 'illegal-instruction',
    label: 'ILLEGAL_INSTRUCTION',
    faultModule: 'addon.node',
  });

  await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
  const [title, options] = warning.mock.calls[0];
  expect(title).toBe('The app seems to have closed unexpectedly last time');
  expect(options.description).toBe(
    'A crash record was found (ILLEGAL_INSTRUCTION · addon.node). Exporting a diagnostics bundle for the developer helps find the cause; nothing is uploaded automatically.',
  );
  expect(options.action.label).toBe('Export diagnostics');
  expect(options.duration).toBeGreaterThanOrEqual(15000);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('crash:dismiss-previous-run-notice'),
  );
});

test('without a classified fault the generic text is used, never an empty "()"', async () => {
  setup({ at: 1, evidence: ['in-flight'], engine: 'whisper-builtin' });

  await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
  const { description } = warning.mock.calls[0][1];
  expect(description).toMatch(/^A crash record was found\. Exporting/);
  expect(description).not.toContain('()');
  expect(description).not.toContain('MISSING:');
});

test('an ISA-class suppression tells the user the built-in addons are off and where to retry', async () => {
  setup({
    at: 1,
    evidence: ['dump', 'in-flight'],
    label: 'ILLEGAL_INSTRUCTION',
    suppressed: [
      { scope: 'family', reason: 'isa', key: 'whisper-x64-prebuilt' },
    ],
  });

  await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
  const options = warning.mock.calls[0][1];
  const [first, second, ...rest] = options.description.split('\n');
  expect(first).toMatch(/^A crash record was found \(ILLEGAL_INSTRUCTION\)\./);
  expect(second).toBe(
    "The built-in speech recognition addons were disabled (this computer's CPU may lack an instruction set they need). Use cloud speech recognition instead, or retry from the “GPU Acceleration” settings.",
  );
  expect(rest).toEqual([]);
  // 多了一行时必须按换行显示，否则两句话会挤成一行
  expect(options.classNames.description).toContain('whitespace-pre-line');
});

test('suppressed candidates are named once each, with the CUDA variant', async () => {
  setup({
    at: 1,
    evidence: ['dump', 'in-flight'],
    label: 'ACCESS_VIOLATION',
    suppressed: [
      { scope: 'candidate', reason: 'crash', key: 'builtin:vulkan' },
      { scope: 'candidate', reason: 'crash', key: 'userData:vulkan' },
      { scope: 'candidate', reason: 'crash', key: 'userData:cuda:12.4.0' },
    ],
  });

  await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
  const lines = warning.mock.calls[0][1].description.split('\n');
  expect(lines[1]).toBe(
    'Disabled automatically: Vulkan, CUDA 12.4.0. Transcription will use something else; you can retry from the “GPU Acceleration” settings.',
  );
  expect(lines[1]).not.toContain('MISSING:');
});

test('an empty suppression list leaves the notice exactly as before', async () => {
  setup({ at: 1, evidence: ['dump'], label: 'SIGSEGV', suppressed: [] });

  await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
  const options = warning.mock.calls[0][1];
  expect(options.description).not.toContain('\n');
  expect(options.classNames).toBeUndefined();
});

test('the action opens the export dialog through the app-level event', async () => {
  setup({ at: 1, evidence: ['dump'], label: 'SIGSEGV' });
  await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));

  const opened = jest.fn();
  window.addEventListener('app-open-diagnostics', opened);
  warning.mock.calls[0][1].action.onClick();
  window.removeEventListener('app-open-diagnostics', opened);

  expect(opened).toHaveBeenCalledTimes(1);
});

test('a mount that is cancelled before the answer arrives neither toasts nor consumes the notice', async () => {
  let release: (value: PreviousRunNotice | null) => void = () => {};
  const invoke = jest.fn(
    (channel: string) =>
      new Promise((resolve) => {
        if (channel === 'crash:previous-run-notice') release = resolve as any;
        else resolve(true);
      }),
  );
  window.ipc = { invoke } as any;
  const { unmount } = render(<PreviousRunNoticeToast />);

  unmount();
  release({ at: 1, evidence: ['dump'], label: 'SIGSEGV' });
  await Promise.resolve();
  await Promise.resolve();

  expect(warning).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith('crash:dismiss-previous-run-notice');
});

test('an IPC failure is swallowed: the app keeps working without the notice', async () => {
  window.ipc = {
    invoke: jest.fn(async () => {
      throw new Error('no handler');
    }),
  } as any;

  render(<PreviousRunNoticeToast />);
  await Promise.resolve();
  await Promise.resolve();

  expect(warning).not.toHaveBeenCalled();
});
