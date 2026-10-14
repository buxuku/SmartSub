/**
 * 诊断面板的主进程入口：日志、环境快照、截图探测、追踪、启动参数预设、导出诊断包。
 *
 * 全部走 automation/handlers 的 ipcMain 门面（本仓库约定，重复注册会抛错）。
 * 每个通道都先检查 isPreviewDiagnosticsEnabled()：正式版里这些通道即使被调用也什么都不做。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  app,
  BrowserWindow,
  dialog,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { dialogWindow } from '../../automation/events';
import { ipcMain } from '../../automation/handlers';
import { createPathRedactor } from '../crash/crashEvents';
import { writeZipFile, type BundleEntry } from '../crash/diagnosticsBundle';
import { logMessage } from '../logger';
import { captureOs, captureViz, type CssRect } from './capture';
import {
  diagnosticsDirectory,
  findGpuPreset,
  GPU_PRESET_FILE,
  GPU_PRESETS,
  isDiagnosticBuild,
  isPreviewDiagnosticsEnabled,
} from './config';
import { interpretProbe } from './diagnosis';
import { getAppliedGpuPresetId, readPendingGpuPresetId } from './earlyInit';
import { NdjsonLog } from './logWriter';
import { collectSnapshot } from './snapshot';
import { isTraceActive, startTrace, stopTrace } from './trace';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 文件名用的本地时间戳：20261014-153045。 */
export function fileStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 用户输入的标记文字只保留适合做文件名的字符。 */
export function safeLabel(label: unknown): string {
  const text = typeof label === 'string' ? label : '';
  return text.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 24) || 'probe';
}

function sanitizeRect(raw: unknown): CssRect {
  const source = (raw ?? {}) as Partial<Record<keyof CssRect, unknown>>;
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return {
    x: num(source.x),
    y: num(source.y),
    width: num(source.width),
    height: num(source.height),
  };
}

function sanitizeDark(
  raw: unknown,
): { darkRatio: number; mean?: number } | null {
  const source = raw as
    | { darkRatio?: unknown; mean?: unknown }
    | null
    | undefined;
  if (
    !source ||
    typeof source.darkRatio !== 'number' ||
    !Number.isFinite(source.darkRatio)
  ) {
    return null;
  }
  return {
    darkRatio: source.darkRatio,
    mean: typeof source.mean === 'number' ? source.mean : undefined,
  };
}

let log: NdjsonLog | null = null;
const startedAt = Date.now();

/**
 * 发起请求的真实窗口。background.ts 里的 mainWindow 是个代理（webContents 是合成的，
 * 没有 capturePage），抓图和快照必须用真正的 BrowserWindow。
 */
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  try {
    return BrowserWindow.fromWebContents(event.sender);
  } catch {
    // 自动化通道没有真实的 webContents
    return null;
  }
}

function rootDir(): string {
  return diagnosticsDirectory(app.getPath('userData'));
}

function getLog(): NdjsonLog {
  log ??= new NdjsonLog(path.join(rootDir(), 'events.ndjson'));
  return log;
}

/** 主进程自己的事件（快照、截图、追踪的起止）也进同一份日志，和渲染进程的事件按时间对齐。 */
export function logDiagEvent(entry: Record<string, unknown>): void {
  if (!isPreviewDiagnosticsEnabled()) return;
  void getLog().append([{ t: Date.now(), src: 'main', ...entry }]);
}

function createRedactor() {
  const roots = [os.homedir(), app.getPath('home'), app.getPath('userData')];
  // 同一个目录可能有两种写法（macOS 的 /var → /private/var，Windows 的 8.3 短路径），
  // 命令行里出现的未必是 Electron 返回的那一种，所以把真实路径也一并脱敏。
  for (const root of [...roots]) {
    try {
      roots.push(fs.realpathSync.native(root));
    } catch {
      // 目录还不存在，没有真实路径可补
    }
  }
  return createPathRedactor(roots);
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir))
      .filter((name) => name.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function readmeText(): string {
  return [
    'SmartSub 视频合成预览黑屏诊断包',
    `生成时间：${new Date().toISOString()}`,
    `应用版本：${app.getVersion()}${isDiagnosticBuild() ? '（诊断版）' : ''}`,
    `系统：${process.platform} ${os.release()} ${process.arch}`,
    `本次启动参数预设：${getAppliedGpuPresetId()}`,
    '',
    '内容：',
    '  events.ndjson        事件日志，每行一条 JSON（鼠标所在区域、视频播放事件、实验开关、标记、探测结果）',
    '  snapshots/           环境快照（显卡、驱动、显示器、GPU 功能状态、DWM 注册表）',
    '  captures/            标记时自动保存的截图：-os 是系统层（和肉眼一致），-viz 是 Chromium 合成器层',
    '  traces/              GPU / 合成器追踪（.json.gz，可用 chrome://tracing 或 ui.perfetto.dev 打开）',
    '',
    '注意：截图包含当时的窗口画面（视频内容、文件名等），如涉及隐私请先检查再发送。',
    '路径中的用户目录已替换为 ~。',
    '',
  ].join('\n');
}

export function setupPreviewDiagnosticsHandlers(
  mainWindow: BrowserWindow,
): void {
  const disabled = { ok: false, error: 'preview diagnostics are not enabled' };

  ipcMain.handle('previewDiag:info', () => {
    if (!isPreviewDiagnosticsEnabled()) return { enabled: false };
    return {
      enabled: true,
      diagnosticBuild: isDiagnosticBuild(),
      platform: process.platform,
      appVersion: app.getVersion(),
      startedAt,
      tracing: isTraceActive(),
      appliedPresetId: getAppliedGpuPresetId(),
      pendingPresetId: readPendingGpuPresetId(),
      presets: GPU_PRESETS.map(({ id, label, detail }) => ({
        id,
        label,
        detail,
      })),
      dir: createRedactor()(rootDir()),
    };
  });

  ipcMain.handle('previewDiag:log', async (_event, entries: unknown) => {
    if (!isPreviewDiagnosticsEnabled() || !Array.isArray(entries)) return false;
    await getLog().append(
      entries.map((entry) =>
        entry && typeof entry === 'object'
          ? { src: 'renderer', ...entry }
          : { src: 'renderer', entry },
      ),
    );
    return true;
  });

  ipcMain.handle('previewDiag:snapshot', async (event, context: unknown) => {
    if (!isPreviewDiagnosticsEnabled()) return disabled;
    const snapshot = await collectSnapshot(senderWindow(event), { context });
    const text = createRedactor()(JSON.stringify(snapshot, null, 2));
    const dir = path.join(rootDir(), 'snapshots');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = `snapshot-${fileStamp()}.json`;
    await fs.promises.writeFile(path.join(dir, file), text);
    logDiagEvent({ type: 'snapshot', file });
    logMessage(`[preview-diag] snapshot saved: ${file}`, 'info');
    return { ok: true, file };
  });

  ipcMain.handle('previewDiag:probe', async (event, request: unknown) => {
    if (!isPreviewDiagnosticsEnabled()) return disabled;
    const win = senderWindow(event);
    if (!win) return { ok: false, error: 'no window' };
    const req = (request ?? {}) as {
      label?: unknown;
      rect?: unknown;
      baseline?: unknown;
      context?: unknown;
    };
    const rect = sanitizeRect(req.rect);
    const label = safeLabel(req.label);
    const name = `${fileStamp()}-${label}`;
    const dir = path.join(rootDir(), 'captures');
    // 顺序有讲究：系统层截图不碰 Chromium 的合成状态，先做；
    // capturePage 会发起 copy request，让 Chromium 暂时放弃叠加层，可能改变现场，放最后。
    const osResult = await captureOs(win, rect, dir, name);
    await sleep(300);
    const vizResult = await captureViz(win, rect, dir, name);
    const baseline = sanitizeDark(req.baseline);
    const verdict = interpretProbe({
      baseline,
      viz: vizResult.ok ? vizResult.video : null,
      os: osResult.ok ? osResult.video : null,
    });
    logDiagEvent({
      type: 'probe',
      label,
      rect,
      os: osResult,
      viz: vizResult,
      baseline,
      verdict,
      context: req.context,
    });
    return { ok: true, os: osResult, viz: vizResult, verdict };
  });

  ipcMain.handle('previewDiag:trace', async (_event, action: unknown) => {
    if (!isPreviewDiagnosticsEnabled()) return disabled;
    try {
      if (action === 'start') {
        await startTrace();
        logDiagEvent({ type: 'trace', action: 'start' });
        return { ok: true };
      }
      if (action === 'stop') {
        const result = await stopTrace(
          path.join(rootDir(), 'traces'),
          `trace-${fileStamp()}`,
        );
        logDiagEvent({ type: 'trace', action: 'stop', ...result });
        return { ok: true, ...result };
      }
      return { ok: false, error: 'unknown action' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDiagEvent({ type: 'trace', action: String(action), error: message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('previewDiag:setPreset', async (_event, id: unknown) => {
    if (!isPreviewDiagnosticsEnabled()) return disabled;
    const preset = findGpuPreset(id);
    await fs.promises.mkdir(rootDir(), { recursive: true });
    await fs.promises.writeFile(
      path.join(rootDir(), GPU_PRESET_FILE),
      JSON.stringify({
        presetId: preset.id,
        savedAt: new Date().toISOString(),
      }),
    );
    logDiagEvent({ type: 'preset', id: preset.id });
    await getLog().flush();
    // 与应用内「重启」同一套做法：先 relaunch，再走正常的 quit 流程
    app.relaunch();
    setImmediate(() => app.quit());
    return { ok: true, id: preset.id };
  });

  ipcMain.handle('previewDiag:openFolder', async () => {
    if (!isPreviewDiagnosticsEnabled()) return disabled;
    await fs.promises.mkdir(rootDir(), { recursive: true });
    const error = await shell.openPath(rootDir());
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('previewDiag:export', async () => {
    if (!isPreviewDiagnosticsEnabled()) return disabled;
    try {
      await getLog().flush();
      const redact = createRedactor();
      const now = new Date();
      const entries: BundleEntry[] = [
        { name: 'README.txt', content: readmeText(), mtime: now },
      ];

      for (const name of ['events.ndjson', 'events.ndjson.1']) {
        const text = await readTextOrNull(path.join(rootDir(), name));
        if (text) entries.push({ name, content: redact(text), mtime: now });
      }
      const snapshotsDir = path.join(rootDir(), 'snapshots');
      for (const name of await listFiles(snapshotsDir, '.json')) {
        const text = await readTextOrNull(path.join(snapshotsDir, name));
        if (text)
          entries.push({
            name: `snapshots/${name}`,
            content: redact(text),
            mtime: now,
          });
      }
      const capturesDir = path.join(rootDir(), 'captures');
      for (const name of await listFiles(capturesDir, '.png')) {
        entries.push({
          name: `captures/${name}`,
          filePath: path.join(capturesDir, name),
          mtime: now,
        });
      }
      const tracesDir = path.join(rootDir(), 'traces');
      for (const name of await listFiles(tracesDir, '.json.gz')) {
        entries.push({
          name: `traces/${name}`,
          filePath: path.join(tracesDir, name),
          mtime: now,
        });
      }

      const chosen = await dialog.showSaveDialog(dialogWindow(mainWindow), {
        title: '导出预览诊断包',
        defaultPath: path.join(
          app.getPath('desktop'),
          `SmartSub-preview-diag-${fileStamp()}.zip`,
        ),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (chosen.canceled || !chosen.filePath)
        return { ok: false, canceled: true };
      const bytes = await writeZipFile(chosen.filePath, entries);
      logDiagEvent({ type: 'export', files: entries.length, bytes });
      shell.showItemInFolder(chosen.filePath);
      return { ok: true, file: chosen.filePath, bytes, files: entries.length };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  if (isPreviewDiagnosticsEnabled()) {
    logDiagEvent({
      type: 'session-start',
      appVersion: app.getVersion(),
      diagnosticBuild: isDiagnosticBuild(),
      presetId: getAppliedGpuPresetId(),
      argv: process.argv.slice(1).map((arg) => createRedactor()(arg)),
    });
  }
}
