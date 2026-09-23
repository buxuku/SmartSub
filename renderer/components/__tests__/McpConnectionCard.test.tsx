import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import McpConnectionCard from '../settings/McpConnectionCard';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn() } }));

const config = {
  json: '{"mcpServers":{"smartsub":{"command":"/Apps/Smart Sub"}}}',
  toml: '[mcp_servers.smartsub]\ncommand = "/Apps/Smart Sub"\n',
};
let invoke: jest.Mock;
let copy: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(async (channel) => {
    if (channel === 'mcp:get-config') return config;
    if (channel === 'mcp:install-cursor') return true;
    throw new Error(channel);
  });
  window.ipc = { invoke } as any;
  copy = jest.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: copy },
  });
});
function selectClient(name: string) {
  // Radix Tabs selects on pointer down.
  fireEvent.mouseDown(screen.getByRole('tab', { name }), {
    button: 0,
    ctrlKey: false,
  });
}

test('Cursor import uses dedicated IPC and each client copies its matching configuration', async () => {
  render(<McpConnectionCard />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'mcp.installCursor' }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('mcp:install-cursor'),
  );
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('mcp.cursorOpened'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'mcp.copyConfig' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(config.json));
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Codex' })).toBeEnabled(),
  );
  selectClient('Codex');
  expect(
    screen.queryByRole('button', { name: 'mcp.installCursor' }),
  ).not.toBeInTheDocument();
  expect(screen.getByText('mcp.codexHint')).toBeVisible();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'mcp.copyConfig' }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'mcp.copyConfig' }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(config.toml));
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'mcp.other' })).toBeEnabled(),
  );
  selectClient('mcp.other');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'mcp.copyConfig' }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'mcp.copyConfig' }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(config.json));
});

test('load failures offer a retry and do not expose unusable install actions', async () => {
  invoke.mockRejectedValueOnce(new Error('MCP_ENTRY_UNAVAILABLE'));
  render(<McpConnectionCard />);
  expect(await screen.findByRole('alert')).toHaveTextContent('mcp.loadFailed');
  expect(
    screen.queryByRole('button', { name: 'mcp.installCursor' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'mcp.retry' }));
  expect(
    await screen.findByRole('button', { name: 'mcp.installCursor' }),
  ).toBeEnabled();
});

test('Cursor launch failure retains manual copy; clipboard failure retains the preview', async () => {
  invoke.mockImplementation(async (channel) => {
    if (channel === 'mcp:get-config') return config;
    throw new Error('No protocol handler');
  });
  render(<McpConnectionCard />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'mcp.installCursor' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'mcp.cursorFailed',
  );
  expect(toast.success).not.toHaveBeenCalled();
  copy.mockRejectedValueOnce(new Error('Clipboard denied'));
  fireEvent.click(screen.getByRole('button', { name: 'mcp.copyConfig' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('mcp.copyFailed'),
  );
  expect(screen.getByLabelText('mcp.preview')).toHaveTextContent(config.json);
});
