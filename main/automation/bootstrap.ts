// This must run before any module constructs electron-store.
import { app } from 'electron';
import path from 'path';
// 只依赖 electron 与纯逻辑模块，不会触发 electron-store 的构造
import { startCrashReporting } from '../helpers/crash/crashReporting';
import {
  DIAG_PRODUCT_NAME,
  isDiagnosticBuild,
} from '../helpers/previewDiagnostics/config';

export const backgroundOnly = process.argv.includes('--automation-background');
const dataArg = process.argv.find((arg) =>
  arg.startsWith('--automation-data-dir='),
);
const explicitData = dataArg?.slice('--automation-data-dir='.length);
if (explicitData) app.setPath('userData', path.resolve(explicitData));
else if (
  isDiagnosticBuild() &&
  !process.argv.some((arg) => arg.startsWith('--user-data-dir'))
)
  // 预览黑屏诊断安装包与正式版并存：数据目录独立，装/卸诊断版都碰不到正式版的数据
  app.setPath('userData', path.join(app.getPath('appData'), DIAG_PRODUCT_NAME));
else if (process.env.NODE_ENV !== 'production')
  app.setPath('userData', `${app.getPath('userData')}-dev`);

// 崩溃诊断：须在 userData 确定之后、任何子进程（utilityProcess）创建之前启动，
// 否则子进程崩溃时拿不到真实退出码与转储（见 crashReporting.ts 的说明）。
startCrashReporting();

// A profile has one writer, whether started from the desktop, CLI or MCP.
if (!app.requestSingleInstanceLock({ backgroundOnly })) process.exit(0);
if (backgroundOnly && process.platform === 'darwin') app.dock?.hide();
