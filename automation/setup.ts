import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function quote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
export async function setup(kind: string, options: any) {
  const executable =
    options.appPath || process.env.SMARTSUB_APP_PATH || process.execPath;
  const entry = path.join(__dirname, 'cli.cjs');
  const directory = path.join(os.homedir(), '.local', 'bin');
  const command = path.join(
    directory,
    process.platform === 'win32' ? 'smartsub.cmd' : 'smartsub',
  );
  if (kind === 'cli') {
    if (!options.install)
      return {
        command,
        action: 'Run setup cli --install to create the user-local launcher.',
        pathDirectory: directory,
      };
    fs.mkdirSync(directory, { recursive: true });
    const dev = process.env.SMARTSUB_DEV === '1';
    const content =
      process.platform === 'win32'
        ? `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${dev ? 'set "SMARTSUB_DEV=1"\r\n' : ''}"${executable}" "${entry}" %*\r\n`
        : `#!/bin/sh\n${dev ? 'SMARTSUB_DEV=1 ' : ''}ELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} ${quote(entry)} "$@"\n`;
    if (fs.existsSync(command))
      fs.copyFileSync(command, `${command}.${Date.now()}.bak`);
    fs.writeFileSync(command, content, { mode: 0o755 });
    fs.chmodSync(command, 0o755);
    return {
      command,
      pathDirectory: directory,
      message:
        'Launcher installed. Add this directory to PATH if needed, or use its absolute path.',
    };
  }
  if (kind !== 'mcp' || !['codex', 'claude'].includes(options.client))
    throw new Error('Use setup mcp --client codex|claude');
  const args = [
    entry,
    'mcp',
    ...(options.dataDir ? ['--data-dir', path.resolve(options.dataDir)] : []),
  ];
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    SMARTSUB_APP_PATH: executable,
    ...(process.env.SMARTSUB_DEV === '1' ? { SMARTSUB_DEV: '1' } : {}),
  };
  const config = { command: executable, args, env };
  if (!options.install)
    return {
      client: options.client,
      config,
      action: 'Run with --install to register only the smartsub server.',
    };
  const configPath =
    options.client === 'codex'
      ? path.join(
          process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
          'config.toml',
        )
      : path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(configPath))
    fs.copyFileSync(configPath, `${configPath}.${Date.now()}.bak`);
  // Let the client's parser preserve all unrelated configuration.
  const addArgs =
    options.client === 'codex'
      ? [
          'mcp',
          'add',
          'smartsub',
          ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
          '--',
          executable,
          ...args,
        ]
      : [
          'mcp',
          'add',
          '--scope',
          'user',
          '--transport',
          'stdio',
          'smartsub',
          ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          '--',
          executable,
          ...args,
        ];
  const result = spawnSync(options.client, addArgs, {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message || result.stderr || 'MCP registration failed',
    );
  return {
    installed: true,
    client: options.client,
    config,
    message: result.stdout.trim(),
  };
}
