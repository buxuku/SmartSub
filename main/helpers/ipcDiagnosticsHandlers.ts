import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { dialogWindow } from '../automation/events';
import { ipcMain } from '../automation/handlers';
import { logMessage, store } from './storeManager';
import { sanitizeLogMessage } from './utils';
import { flushLogWrites, listLogFiles, readLogFileText } from './logStorage';
import { getBuildInfo } from './buildInfo';
import { getGpuEnvironment } from './cudaUtils';
import { getActiveBackend } from './addonLoader';
import {
  getCrashDumpsDir,
  getCrashEventsFile,
  isCrashReporterStarted,
} from './crash/crashReporting';
import {
  createPathRedactor,
  readCrashEvents,
  rotatedFileOf,
} from './crash/crashEvents';
import { listDumpFiles } from './crash/crashDumps';
import { describeExit } from './crash/exitClassifier';
import { summarizeMinidumpFile } from './crash/minidumpSummary';
import { gatherSystemInfo } from './crash/systemInfo';
import {
  buildBundleEntries,
  buildIssueUrl,
  collectDiagnosticsInput,
  describePathSetting,
  diagnosticsFileName,
  previewDiagnostics,
  writeZipFile,
  type DiagnosticsSources,
} from './crash/diagnosticsBundle';
import type {
  DiagnosticsExportRequest,
  DiagnosticsExportResult,
  DiagnosticsExported,
} from '../../types/diagnostics';

/** 显卡环境的探测要跑外部命令，偶尔很慢；诊断包不能因此卡住。 */
const GPU_PROBE_TIMEOUT_MS = 8000;

/** 本次运行里由我们生成的诊断包路径：只允许对这些路径做“在文件夹中显示”。 */
const exportedFiles = new Set<string>();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function createRedactor() {
  return createPathRedactor([
    os.homedir(),
    app.getPath('home'),
    app.getPath('userData'),
  ]);
}

function appInfo() {
  const userData = describePathSetting(app.getPath('userData'));
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    crashReporterStarted: isCrashReporterStarted(),
    // 数据目录的路径本身不导出，只说明会不会因为非 ASCII / 空格出问题
    userDataPath: { nonAscii: userData.nonAscii, hasSpace: userData.hasSpace },
  };
}

function createSources(): DiagnosticsSources {
  return {
    now: Date.now(),
    appVersion: app.getVersion(),
    crashReporterEnabled: isCrashReporterStarted(),
    listLogFiles,
    readLog: readLogFileText,
    readCrashEvents: async () => {
      const file = getCrashEventsFile();
      return {
        current: await readTextOrNull(file),
        rotated: await readTextOrNull(rotatedFileOf(file)),
      };
    },
    listDumps: () => listDumpFiles(getCrashDumpsDir()),
    summarizeDump: (file) => summarizeMinidumpFile(file),
    system: async () => ({
      app: appInfo(),
      buildInfo: getBuildInfo(),
      ...(await gatherSystemInfo()),
    }),
    gpu: () =>
      withTimeout(getGpuEnvironment(), GPU_PROBE_TIMEOUT_MS, 'gpu detection'),
    settings: () => ({
      settings: store.get('settings'),
      userConfig: store.get('userConfig'),
    }),
    addon: () => ({
      active: getActiveBackend(),
      lastLoadResult: store.get('lastAddonLoadResult') ?? null,
      history: store.get('addonLoadHistory') ?? [],
    }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uiLanguage(): 'zh' | 'en' {
  return store.get('settings')?.language === 'zh' ? 'zh' : 'en';
}

function defaultSaveDir(): string {
  for (const name of ['downloads', 'documents', 'home'] as const) {
    try {
      return app.getPath(name);
    } catch {
      // 该目录在此平台上不可用，换下一个
    }
  }
  return os.homedir();
}

function latestCrashLine(): string | null {
  const [event] = readCrashEvents(getCrashEventsFile(), { limit: 1 });
  if (!event) return null;
  return event.classification
    ? describeExit(event.classification)
    : (event.reason ?? event.source);
}

/**
 * 收集并写出诊断包。与保存对话框分开，便于在真实 Electron 里不经界面直接验证。
 * 抛错由调用方转成界面可见的失败结果。
 */
export async function exportDiagnosticsFile(
  filePath: string,
  includeRawDumps: boolean,
  sources: DiagnosticsSources = createSources(),
): Promise<DiagnosticsExported> {
  // 让刚刚产生的日志（包括崩溃事件那几行）先落盘，再读取
  await flushLogWrites();
  const input = await collectDiagnosticsInput(sources);
  const { entries, manifest } = buildBundleEntries(input, {
    includeRawDumps,
    sanitize: sanitizeLogMessage,
    redact: createRedactor(),
  });
  const bytes = await writeZipFile(filePath, entries);
  exportedFiles.add(filePath);
  logMessage(
    `Diagnostics bundle exported (${bytes} bytes, ${entries.length} entries, raw dumps: ${manifest.rawDumps.length})`,
    'info',
  );
  return {
    ok: true,
    filePath,
    bytes,
    rawDumps: manifest.rawDumps.length,
    warnings: manifest.collectErrors,
  };
}

export function setupDiagnosticsHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('diagnostics:preview', async () =>
    previewDiagnostics(createSources()),
  );

  ipcMain.handle(
    'diagnostics:export',
    async (
      _event,
      request?: Partial<DiagnosticsExportRequest>,
    ): Promise<DiagnosticsExportResult> => {
      const includeRawDumps = request?.includeRawDumps === true;
      try {
        const zh = uiLanguage() === 'zh';
        const chosen = await dialog.showSaveDialog(dialogWindow(mainWindow), {
          title: zh ? '导出诊断包' : 'Export diagnostics bundle',
          defaultPath: path.join(
            defaultSaveDir(),
            diagnosticsFileName(Date.now()),
          ),
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        });
        if (chosen.canceled || !chosen.filePath) {
          return { ok: false, canceled: true };
        }
        return await exportDiagnosticsFile(chosen.filePath, includeRawDumps);
      } catch (error) {
        logMessage(`Diagnostics export failed: ${errorText(error)}`, 'error');
        return { ok: false, error: errorText(error) };
      }
    },
  );

  ipcMain.handle('diagnostics:reveal', (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !exportedFiles.has(filePath)) {
      return false;
    }
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('diagnostics:issue-url', async () => {
    const system = await gatherSystemInfo();
    let gpuNames: string[] = [];
    try {
      const gpu = await withTimeout(
        getGpuEnvironment(),
        GPU_PROBE_TIMEOUT_MS,
        'gpu detection',
      );
      gpuNames = gpu.gpus.map((g) => g.name).filter(Boolean);
    } catch {
      // 没有显卡信息也能提 issue
    }
    return buildIssueUrl(
      {
        appVersion: app.getVersion(),
        os: `${system.os.platform} ${system.os.release} (${system.os.arch})`,
        cpuModel: system.cpu.model,
        gpuNames,
        latestCrash: latestCrashLine(),
      },
      uiLanguage(),
    );
  });
}
