/**
 * 崩溃诊断的 Electron 适配层：启动 crashReporter（只写本地、绝不上传）并注册监听。
 *
 * 本文件由 automation/bootstrap.ts 在 userData 确定之后、抢单实例锁之前导入，
 * 所以只能依赖 electron 与纯逻辑模块——不能（直接或间接）引入 electron-store，
 * 否则 store 会在 userData 被改写之前就按旧路径构造。应用日志经 setLogSink 注入。
 *
 * 为什么必须启用 crashReporter（PoC 在 windows-latest 上实测）：
 * 不启用时，子进程崩溃的退出码会被 Crashpad 改写成 0xFFFF7003，真实异常码丢失，
 * 也没有任何转储；启用后退出码恢复为真实 NTSTATUS（如 0xC000001D），并产生 .dmp。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, crashReporter } from 'electron';
import { snapshotCrashContext } from './crashContext';
import { pruneDumpFiles } from './crashDumps';
import {
  appendCrashEvent,
  createPathRedactor,
  pruneCrashEvents,
} from './crashEvents';
import {
  createCrashMonitor,
  type CrashLogSink,
  type CrashMonitor,
  type UtilityExitReport,
} from './crashMonitor';
import { beginRun } from './runLifecycle';

/** 回退开关：SMARTSUB_DISABLE_CRASH_REPORTER=true 不启动 crashReporter（监听与事件记录仍保留） */
const DISABLE_ENV = 'SMARTSUB_DISABLE_CRASH_REPORTER';

let reporterStarted = false;
let monitor: CrashMonitor | null = null;
let listenersInstalled = false;

/** Crashpad 数据库目录（含 .dmp）。 */
export function getCrashDumpsDir(): string {
  return path.join(app.getPath('userData'), 'crash-dumps');
}

/** 崩溃事件文件。放在 logs/ 下，但文件名不符合“日期.jsonl”，不会被 7 天清理误删。 */
export function getCrashEventsFile(): string {
  return path.join(app.getPath('userData'), 'logs', 'crash-events.jsonl');
}

/** 运行状态文件：记录上次是否正常退出，以及崩溃时仍在进行的原生调用。 */
export function getRunStateFile(): string {
  return path.join(app.getPath('userData'), 'crash-state.json');
}

export function isCrashReporterStarted(): boolean {
  return reporterStarted;
}

function getMonitor(): CrashMonitor {
  if (monitor) return monitor;
  const redact = createPathRedactor([
    os.homedir(),
    app.getPath('home'),
    app.getPath('userData'),
  ]);
  monitor = createCrashMonitor({
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    append: (event) => {
      appendCrashEvent(getCrashEventsFile(), event);
    },
    snapshotContext: snapshotCrashContext,
    redact,
  });
  return monitor;
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const m = getMonitor();
  app.on('child-process-gone', (_event, details) => {
    m.onChildProcessGone(details);
  });
  app.on('render-process-gone', (_event, _webContents, details) => {
    m.onRenderProcessGone(details);
  });
  // 只观察，不改变默认行为：Electron 仍按原样处理未捕获异常。
  // 刻意不挂 unhandledRejection 监听——那会改变主进程对未处理 Promise 拒绝的默认处理。
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    m.onUncaughtException(error, origin);
  });
}

/**
 * 启动崩溃诊断。必须在 app.setPath('userData') 之后调用，且早于任何 utilityProcess 的创建。
 * 任何失败都只打印、不抛出：诊断功能不能让应用起不来。
 */
export function startCrashReporting(): void {
  try {
    installListeners();
  } catch (error) {
    console.error('[crash] failed to install listeners:', error);
  }
  if (reporterStarted) return;
  if (process.env[DISABLE_ENV] === 'true') return;
  try {
    const dir = getCrashDumpsDir();
    fs.mkdirSync(dir, { recursive: true });
    // setPath 必须早于 crashReporter.start
    app.setPath('crashDumps', dir);
    crashReporter.start({ uploadToServer: false });
    reporterStarted = true;
  } catch (error) {
    console.error('[crash] crashReporter failed to start:', error);
  }
}

/**
 * app ready 之后调用：把崩溃事件接入应用日志，并清理过期的事件与转储。
 * 清理放在这里而不是启动最早期，是为了不拖慢首屏；失败静默。
 */
export function initCrashDiagnostics(sink?: CrashLogSink): void {
  if (sink) getMonitor().setLogSink(sink);
  // 先回顾上一次是怎么结束的，再清理：清理可能删掉用来判断的转储与事件
  beginRun({
    stateFile: getRunStateFile(),
    dumpsDir: getCrashDumpsDir(),
    eventsFile: getCrashEventsFile(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    log: sink,
  });
  try {
    pruneCrashEvents(getCrashEventsFile());
    pruneDumpFiles(getCrashDumpsDir());
  } catch (error) {
    console.error('[crash] failed to prune diagnostics:', error);
  }
  sink?.(
    reporterStarted
      ? 'Crash diagnostics ready: crashReporter started (local only, no upload)'
      : `Crash diagnostics ready: crashReporter NOT started${process.env[DISABLE_ENV] === 'true' ? ` (disabled by ${DISABLE_ENV})` : ''}`,
    'info',
  );
}

/** 应用已确认退出：此后不再记录退出过程中的“被杀”。 */
export function markCrashMonitorShuttingDown(): void {
  monitor?.markShuttingDown();
}

/** utilityProcess 宿主异常退出：记一条带 stderr 尾部的事件（只落盘，日志由宿主自己写）。 */
export function recordUtilityExit(report: UtilityExitReport): void {
  getMonitor().onUtilityExit(report);
}

/** 宿主即将主动终止某个 utilityProcess：登记后，随后的“被杀”事件不算异常。 */
export function expectUtilityKill(name: string): void {
  getMonitor().expectKill(name);
}
