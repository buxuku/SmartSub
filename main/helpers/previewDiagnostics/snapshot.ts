/**
 * 环境快照：这台机器「图形栈」的样子。
 *
 * 黑屏只在特定显卡 / 驱动 / DWM 配置下出现，没有这些信息就没法把现象和原因对上。
 * 全部是只读采集；每一节单独 try/catch，某一节拿不到只会在那一节留下错误信息，不影响其它节。
 * 不用 PowerShell（本仓库在 gpuEnumeration.ts 里记录过它的坑），只用 Chromium 自己的 GPU 信息
 * 加几条只读的 reg.exe 查询（DWM、系统版本、HAGS、每应用 GPU 偏好）。
 */
import { app, screen, type BrowserWindow } from 'electron';
import os from 'os';
import path from 'path';
import { runCommandOrThrow } from '../runCommand';
import { WATCHED_SWITCHES } from './config';
import { parseRegQuery } from './regQuery';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms`)),
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

async function section<T>(
  read: () => T | Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await read();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Windows 注册表里和「叠加层 / 合成 / 显卡调度」有关的几处。非 Windows 返回 null。 */
async function readWindowsRegistry(): Promise<Record<string, unknown> | null> {
  if (process.platform !== 'win32') return null;
  const reg = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'reg.exe',
  );
  const query = async (args: string[]) =>
    parseRegQuery(await runCommandOrThrow(reg, ['query', ...args], 5000));
  return {
    // OverlayTestMode=5 是关闭 MPO（多平面叠加）的已知开关，有它说明用户或驱动关过 MPO
    dwm: await section(() =>
      query(['HKLM\\SOFTWARE\\Microsoft\\Windows\\Dwm']),
    ),
    currentVersion: await section(() =>
      query([
        'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
        '/v',
        'DisplayVersion',
      ]),
    ),
    currentBuild: await section(() =>
      query([
        'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
        '/v',
        'UBR',
      ]),
    ),
    // 硬件加速 GPU 调度（HAGS）
    hags: await section(() =>
      query([
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers',
        '/v',
        'HwSchMode',
      ]),
    ),
    // 「图形设置」里给本应用指定的 GPU（双显卡笔记本上会影响用哪块卡），只留和本应用相关的行
    userGpuPreferences: await section(async () => {
      const dumps = await query([
        'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences',
      ]);
      return dumps.map((dump) => ({
        key: dump.key,
        values: Object.fromEntries(
          Object.entries(dump.values).filter(([name]) =>
            /smartsub|electron/i.test(name),
          ),
        ),
      }));
    }),
  };
}

export interface SnapshotExtras {
  /** 触发快照时的实验开关、鼠标区域等，由渲染进程给 */
  context?: unknown;
}

export async function collectSnapshot(
  win: BrowserWindow | null,
  extras: SnapshotExtras = {},
): Promise<Record<string, unknown>> {
  const cpus = os.cpus();
  return {
    collectedAt: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: typeof os.version === 'function' ? os.version() : undefined,
    },
    hardware: {
      cpu: cpus[0]?.model,
      logicalCores: cpus.length,
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    },
    commandLine: {
      argv: process.argv.slice(1),
      switches: Object.fromEntries(
        WATCHED_SWITCHES.map((name) => [
          name,
          app.commandLine.hasSwitch(name)
            ? app.commandLine.getSwitchValue(name) || true
            : false,
        ]),
      ),
    },
    gpuFeatureStatus: await section(() => app.getGPUFeatureStatus()),
    gpuInfo: await section(() => withTimeout(app.getGPUInfo('complete'), 8000)),
    displays: await section(() =>
      screen.getAllDisplays().map((display) => ({
        id: display.id,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
        internal: display.internal,
        colorDepth: display.colorDepth,
        colorSpace: display.colorSpace,
        depthPerComponent: display.depthPerComponent,
        displayFrequency: display.displayFrequency,
      })),
    ),
    processes: await section(() =>
      app.getAppMetrics().map((metric) => ({
        type: metric.type,
        pid: metric.pid,
        name: metric.name,
        cpuPercent: metric.cpu.percentCPUUsage,
        workingSetKB: metric.memory.workingSetSize,
      })),
    ),
    window: await section(() =>
      win && !win.isDestroyed()
        ? {
            bounds: win.getBounds(),
            contentBounds: win.getContentBounds(),
            maximized: win.isMaximized(),
            fullScreen: win.isFullScreen(),
            focused: win.isFocused(),
            displayScaleFactor: screen.getDisplayMatching(win.getBounds())
              .scaleFactor,
          }
        : null,
    ),
    registry: await section(readWindowsRegistry),
    context: extras.context,
  };
}
