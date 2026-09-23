export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpConnectionConfig {
  json: string;
  toml: string;
}
