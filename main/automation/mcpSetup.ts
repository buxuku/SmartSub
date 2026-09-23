import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import {
  createMcpServerConfig,
  cursorInstallUrl,
  formatMcpConfig,
} from '../../automation/mcpConfig';

export function currentMcpServerConfig() {
  let executable = app.getPath('exe');
  let entry = app.isPackaged
    ? path.join(process.resourcesPath, 'automation', 'cli.cjs')
    : path.join(app.getAppPath(), 'app', 'automation', 'cli.cjs');
  if (!fs.existsSync(entry)) throw new Error('MCP_ENTRY_UNAVAILABLE');
  if (app.isPackaged && process.platform === 'linux' && process.env.APPIMAGE) {
    // AppImage mount paths change after exit. Its self-contained CLI bundle
    // must remain readable when Electron is relaunched in Node mode.
    executable = process.env.APPIMAGE;
    const stableEntry = path.join(
      app.getPath('userData'),
      'automation',
      'client',
      'cli.cjs',
    );
    fs.mkdirSync(path.dirname(stableEntry), { recursive: true, mode: 0o700 });
    fs.copyFileSync(entry, `${stableEntry}.tmp`);
    fs.renameSync(`${stableEntry}.tmp`, stableEntry);
    entry = stableEntry;
  }
  return createMcpServerConfig({
    executable,
    entry,
    dataDir: app.getPath('userData'),
    dev: !app.isPackaged,
  });
}

export function setupMcpConfigHandlers() {
  const handle = (channel: string, action: () => unknown) =>
    ipcMain.handle(channel, (event) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('MCP_SETTINGS_WINDOW_REQUIRED');
      return action();
    });
  handle('mcp:get-config', () => formatMcpConfig(currentMcpServerConfig()));
  // Construct the URL in the main process; renderer input cannot change the command.
  handle('mcp:install-cursor', async () => {
    await shell.openExternal(cursorInstallUrl(currentMcpServerConfig()));
    return true;
  });
}
