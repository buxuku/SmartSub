import type { McpConnectionConfig, McpServerConfig } from '../types/mcpConfig';

export function createMcpServerConfig({
  executable,
  entry,
  dataDir,
  dev = false,
}: {
  executable: string;
  entry: string;
  dataDir?: string;
  dev?: boolean;
}): McpServerConfig {
  return {
    command: executable,
    args: [entry, 'mcp', ...(dataDir ? ['--data-dir', dataDir] : [])],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      SMARTSUB_APP_PATH: executable,
      ...(dev ? { SMARTSUB_DEV: '1' } : {}),
    },
  };
}

/** JSON string escaping also produces valid TOML basic strings for local paths. */
export function formatMcpConfig(config: McpServerConfig): McpConnectionConfig {
  return {
    json: JSON.stringify({ mcpServers: { smartsub: config } }, null, 2),
    toml: [
      '[mcp_servers.smartsub]',
      `command = ${JSON.stringify(config.command)}`,
      `args = ${JSON.stringify(config.args)}`,
      '',
      '[mcp_servers.smartsub.env]',
      ...Object.entries(config.env).map(
        ([key, value]) => `${key} = ${JSON.stringify(value)}`,
      ),
      '',
    ].join('\n'),
  };
}

// Cursor expects one server's transport config, without an mcpServers wrapper.
// https://cursor.com/docs/mcp/install-links
export function cursorInstallUrl(config: McpServerConfig): string {
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString(
    'base64',
  );
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=smartsub&config=${encodeURIComponent(encoded)}`;
}
