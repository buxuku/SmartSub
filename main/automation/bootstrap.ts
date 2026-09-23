// This must run before any module constructs electron-store.
import { app } from 'electron';
import path from 'path';

export const backgroundOnly = process.argv.includes('--automation-background');
const dataArg = process.argv.find((arg) =>
  arg.startsWith('--automation-data-dir='),
);
const explicitData = dataArg?.slice('--automation-data-dir='.length);
if (explicitData) app.setPath('userData', path.resolve(explicitData));
else if (process.env.NODE_ENV !== 'production')
  app.setPath('userData', `${app.getPath('userData')}-dev`);

// A profile has one writer, whether started from the desktop, CLI or MCP.
if (!app.requestSingleInstanceLock({ backgroundOnly })) process.exit(0);
if (backgroundOnly && process.platform === 'darwin') app.dock?.hide();
