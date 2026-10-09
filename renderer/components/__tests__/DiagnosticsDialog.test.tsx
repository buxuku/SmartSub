import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiagnosticsDialog } from '../diagnostics/DiagnosticsDialog';
import type {
  DiagnosticsExportResult,
  DiagnosticsPreview,
} from '../../../types/diagnostics';

// 文案取自真实的英文文件：key 写错会在这里暴露，而不是把裸 key 展示给用户。
// 这里的 t 与 next-i18next 一样支持点号嵌套与 {{var}} 插值。
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

const PREVIEW: DiagnosticsPreview = {
  logDays: 3,
  logBytes: 2048,
  crashEventCount: 2,
  dumps: [
    {
      name: 'a.dmp',
      size: 1024 * 1024,
      mtimeMs: 1,
      exception: 'ILLEGAL_INSTRUCTION',
      faultModule: 'addon.node',
    },
  ],
  dumpBytes: 1024 * 1024,
  crashReporterEnabled: true,
  suggestedFileName: 'smartsub-diagnostics-20261009-153012.zip',
};

type Handlers = Record<string, (...args: any[]) => unknown>;

function setup(handlers: Handlers) {
  const invoke = jest.fn(async (channel: string, ...args: unknown[]) =>
    handlers[channel]?.(...args),
  );
  const send = jest.fn();
  window.ipc = { invoke, send } as any;
  const onOpenChange = jest.fn();
  render(<DiagnosticsDialog open onOpenChange={onOpenChange} />);
  return { invoke, send, onOpenChange };
}

const exportButton = () => screen.getByRole('button', { name: 'Export' });

test('opening lists what goes into the bundle, with dump count and size', async () => {
  const { invoke } = setup({ 'diagnostics:preview': () => PREVIEW });

  expect(
    await screen.findByText(
      'Application logs of the last 3 days (about 2.0 KB)',
    ),
  ).toBeInTheDocument();
  expect(screen.getByText('2 crash records')).toBeInTheDocument();
  expect(screen.getByText(/Summaries of 1 crash dumps/)).toBeInTheDocument();
  expect(
    screen.getByRole('checkbox', {
      name: 'Include raw crash dumps (1, 1.0 MB in total)',
    }),
  ).not.toBeChecked();
  expect(
    screen.getByText(/may contain fragments of memory/),
  ).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith('diagnostics:preview');
});

test('exporting without ticking the box never asks for raw dumps', async () => {
  const exported: DiagnosticsExportResult = {
    ok: true,
    filePath: '/tmp/out.zip',
    bytes: 3 * 1024,
    rawDumps: 0,
    warnings: [],
  };
  const { invoke } = setup({
    'diagnostics:preview': () => PREVIEW,
    'diagnostics:export': () => exported,
  });
  await screen.findByText('2 crash records');

  fireEvent.click(exportButton());

  expect(await screen.findByTestId('diagnostics-done')).toHaveTextContent(
    'File size 3.0 KB',
  );
  expect(invoke).toHaveBeenCalledWith('diagnostics:export', {
    includeRawDumps: false,
  });
});

test('ticking the box requests raw dumps', async () => {
  const { invoke } = setup({
    'diagnostics:preview': () => PREVIEW,
    'diagnostics:export': () => ({
      ok: true,
      filePath: '/tmp/out.zip',
      bytes: 10,
      rawDumps: 1,
      warnings: [],
    }),
  });
  await screen.findByText('2 crash records');

  fireEvent.click(
    screen.getByRole('checkbox', { name: /Include raw crash dumps/ }),
  );
  fireEvent.click(exportButton());

  await screen.findByTestId('diagnostics-done');
  expect(invoke).toHaveBeenCalledWith('diagnostics:export', {
    includeRawDumps: true,
  });
});

test('after exporting, the file can be revealed and a prefilled GitHub issue opened', async () => {
  const url = 'https://github.com/buxuku/SmartSub/issues/new?title=x';
  const { invoke, send } = setup({
    'diagnostics:preview': () => PREVIEW,
    'diagnostics:export': () => ({
      ok: true,
      filePath: '/tmp/out.zip',
      bytes: 10,
      rawDumps: 0,
      warnings: ['gpu: timeout'],
    }),
    'diagnostics:issue-url': () => url,
    'diagnostics:reveal': () => true,
  });
  await screen.findByText('2 crash records');
  fireEvent.click(exportButton());
  await screen.findByTestId('diagnostics-done');

  // 部分内容没收集到时要告诉用户，但不是失败
  expect(
    screen.getByText(/1 items could not be collected/),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
  expect(invoke).toHaveBeenCalledWith('diagnostics:reveal', '/tmp/out.zip');

  fireEvent.click(screen.getByRole('button', { name: 'Report on GitHub' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('openUrl', url));
});

test('without dumps there is no raw-dump option', async () => {
  setup({
    'diagnostics:preview': () => ({
      ...PREVIEW,
      crashEventCount: 0,
      dumps: [],
      dumpBytes: 0,
    }),
  });

  expect(await screen.findByText('No crash records yet')).toBeInTheDocument();
  expect(screen.getByText('No crash dumps yet')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

test('a cancelled save dialog leaves the form usable and shows no error', async () => {
  const { invoke } = setup({
    'diagnostics:preview': () => PREVIEW,
    'diagnostics:export': () => ({ ok: false, canceled: true }),
  });
  await screen.findByText('2 crash records');

  fireEvent.click(exportButton());

  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'diagnostics:export',
      expect.anything(),
    ),
  );
  await waitFor(() => expect(exportButton()).toBeEnabled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByTestId('diagnostics-done')).not.toBeInTheDocument();
});

test('an export failure is shown and the user can try again', async () => {
  setup({
    'diagnostics:preview': () => PREVIEW,
    'diagnostics:export': () => ({ ok: false, error: 'disk full' }),
  });
  await screen.findByText('2 crash records');

  fireEvent.click(exportButton());

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Export failed: disk full',
  );
  expect(exportButton()).toBeEnabled();
});

test('when the contents cannot be read, the error is shown and export stays disabled', async () => {
  setup({
    'diagnostics:preview': () => {
      throw new Error('preview broke');
    },
  });

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Export failed: preview broke',
  );
  expect(exportButton()).toBeDisabled();
});

test('warns when crash dump recording has been switched off', async () => {
  setup({
    'diagnostics:preview': () => ({ ...PREVIEW, crashReporterEnabled: false }),
  });

  expect(
    await screen.findByText(/Crash dump recording has been turned off/),
  ).toBeInTheDocument();
});
