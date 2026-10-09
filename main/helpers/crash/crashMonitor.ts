/**
 * 崩溃监视的核心逻辑（纯函数 + 注入依赖，不引用 electron，便于单测）。
 *
 * 把 Electron 的 child-process-gone / render-process-gone / uncaughtExceptionMonitor
 * 三类信号归一成 CrashEvent：分类、过滤噪声、同步落盘、再交给日志。
 * 事件的监听注册在 crashReporting.ts，这里只负责“收到一条信号之后做什么”。
 *
 * 约束：监视器自己绝不抛错——它跑在别的东西已经出问题的时候。
 */
import {
  classifyExit,
  describeExit,
  type ExitClassification,
} from './exitClassifier';
import type { CrashContextEntry } from './crashContext';
import type { CrashEvent, CrashEventSource } from './crashEvents';

/**
 * Electron child-process-gone 的 details（只取用到的字段，结构上兼容 Electron.Details）。
 * 实测样例（macOS arm64，Electron 30.5.1，utilityProcess.fork({ serviceName: 'smoke-crash' }) 里 process.crash()）：
 * { type: 'Utility', reason: 'crashed', exitCode: 11, serviceName: 'node.mojom.NodeService', name: 'smoke-crash' }
 */
export interface ChildGoneDetails {
  type?: string;
  reason?: string;
  exitCode?: number;
  serviceName?: string;
  name?: string;
}

/** Electron render-process-gone 的 details */
export interface RenderGoneDetails {
  reason?: string;
  exitCode?: number;
}

export type CrashLogLevel = 'info' | 'warning' | 'error';
export type CrashLogSink = (message: string, level: CrashLogLevel) => void;

export interface CrashMonitorOptions {
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
  /** 同步落盘一条事件（crash-events.jsonl） */
  append: (event: CrashEvent) => void;
  snapshotContext: () => CrashContextEntry[];
  /** 抹掉用户目录等前缀；缺省不处理 */
  redact?: (text: string) => string;
  now?: () => number;
}

export interface CrashMonitor {
  onChildProcessGone(details: ChildGoneDetails): CrashEvent | null;
  onRenderProcessGone(details: RenderGoneDetails): CrashEvent | null;
  onUncaughtException(error: unknown, origin?: string): CrashEvent | null;
  /** 应用已确认退出：此后只记崩溃，不再记“被杀”这类退出过程中的正常现象 */
  markShuttingDown(): void;
  /** 接入应用日志；接入之前产生的日志先缓存，接入时按序补发 */
  setLogSink(sink: CrashLogSink | null): void;
}

const MAX_PENDING_LOGS = 50;
const MAX_EVENTS_PER_SESSION = 200;
const UNCAUGHT_DEDUPE_MS = 10_000;
const MAX_UNCAUGHT_PER_SESSION = 50;
const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_LINES = 8;
const MAX_STACK_CHARS = 1500;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stackTop(stack: string): string {
  return truncate(
    stack.split('\n').slice(0, MAX_STACK_LINES).join('\n'),
    MAX_STACK_CHARS,
  );
}

function describeContext(context: CrashContextEntry[] | undefined): string {
  if (!context || context.length === 0) return '';
  const parts = context.map((c) =>
    [c.engine, c.backend, c.model, c.phase].filter(Boolean).join('/'),
  );
  return ` active=[${parts.join(', ')}]`;
}

/** 一条事件对应的单行日志文本（不含花括号，免得被日志脱敏器当成 JSON 处理）。 */
export function formatCrashEventForLog(event: CrashEvent): string {
  if (event.source === 'uncaught-exception') {
    const what = [event.errorName, event.message].filter(Boolean).join(': ');
    return `[crash] uncaught exception in main process (${event.detail ?? 'uncaughtException'}): ${what}${describeContext(event.context)}`;
  }
  // 实测（macOS，Electron 30.5.1）：utilityProcess.fork({ serviceName: 'x' }) 的名字出现在
  // details.name，而 details.serviceName 是 Chromium 自己的 Mojo 服务名（node.mojom.NodeService）。
  // 所以优先显示 name；两者都有时把 Chromium 的服务名放进括号。
  const label = event.name || event.serviceName;
  const mojo =
    event.name && event.serviceName && event.serviceName !== event.name
      ? ` (${event.serviceName})`
      : '';
  const who = [event.processType, label ? `${label}${mojo}` : '']
    .filter(Boolean)
    .join(' ');
  const cls = event.classification;
  const what = cls ? describeExit(cls) : 'unknown';
  const parts = [`[crash] ${event.source}`];
  if (who) parts.push(who);
  const head = `${parts.join(' ')}: ${what}`;
  const extra = [
    event.reason ? `reason=${event.reason}` : '',
    typeof event.exitCode === 'number' ? `exitCode=${event.exitCode}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${head}${extra ? ` ${extra}` : ''}${describeContext(event.context)}`;
}

export function createCrashMonitor(options: CrashMonitorOptions): CrashMonitor {
  const now = options.now ?? Date.now;
  const redact = options.redact ?? ((text: string) => text);

  let shuttingDown = false;
  let sink: CrashLogSink | null = null;
  const pendingLogs: Array<{ message: string; level: CrashLogLevel }> = [];
  let recorded = 0;
  let uncaughtCount = 0;
  const uncaughtSeen = new Map<string, number>();

  function emitLog(message: string, level: CrashLogLevel): void {
    try {
      if (sink) {
        sink(message, level);
        return;
      }
      pendingLogs.push({ message, level });
      if (pendingLogs.length > MAX_PENDING_LOGS) pendingLogs.shift();
    } catch {
      // 日志失败不能影响崩溃记录
    }
  }

  function commit(event: CrashEvent, level: CrashLogLevel): CrashEvent {
    recorded++;
    try {
      options.append(event);
    } catch (error) {
      console.error('[crash] append failed:', error);
    }
    emitLog(formatCrashEventForLog(event), level);
    return event;
  }

  function base(source: CrashEventSource): CrashEvent {
    let context: CrashContextEntry[] = [];
    try {
      context = options.snapshotContext();
    } catch {
      // 现场信息取不到就不带
    }
    return {
      ts: now(),
      source,
      ...(context.length > 0 ? { context } : {}),
      appVersion: options.appVersion,
      platform: options.platform,
      arch: options.arch,
    };
  }

  function shouldRecord(classification: ExitClassification): boolean {
    if (!classification.abnormal) return false;
    if (recorded >= MAX_EVENTS_PER_SESSION) return false;
    if (shuttingDown && !classification.isCrash) return false;
    return true;
  }

  return {
    onChildProcessGone(details) {
      try {
        const classification = classifyExit({
          platform: options.platform,
          exitCode: details.exitCode,
          reason: details.reason,
        });
        if (!shouldRecord(classification)) return null;
        const event: CrashEvent = {
          ...base('child-process-gone'),
          ...(details.type ? { processType: details.type } : {}),
          ...(details.serviceName ? { serviceName: details.serviceName } : {}),
          ...(details.name ? { name: details.name } : {}),
          ...(details.reason ? { reason: details.reason } : {}),
          ...(typeof details.exitCode === 'number'
            ? { exitCode: details.exitCode }
            : {}),
          classification,
        };
        return commit(event, classification.isCrash ? 'error' : 'warning');
      } catch (error) {
        console.error('[crash] child-process-gone handler failed:', error);
        return null;
      }
    },

    onRenderProcessGone(details) {
      try {
        const classification = classifyExit({
          platform: options.platform,
          exitCode: details.exitCode,
          reason: details.reason,
        });
        if (!shouldRecord(classification)) return null;
        const event: CrashEvent = {
          ...base('render-process-gone'),
          processType: 'Renderer',
          ...(details.reason ? { reason: details.reason } : {}),
          ...(typeof details.exitCode === 'number'
            ? { exitCode: details.exitCode }
            : {}),
          classification,
        };
        return commit(event, classification.isCrash ? 'error' : 'warning');
      } catch (error) {
        console.error('[crash] render-process-gone handler failed:', error);
        return null;
      }
    },

    onUncaughtException(error, origin) {
      try {
        if (recorded >= MAX_EVENTS_PER_SESSION) return null;
        if (uncaughtCount >= MAX_UNCAUGHT_PER_SESSION) return null;
        const err = error instanceof Error ? error : undefined;
        const rawMessage = err ? err.message : String(error);
        const message = redact(truncate(rawMessage, MAX_MESSAGE_CHARS));
        const stack = err?.stack ? redact(stackTop(err.stack)) : undefined;
        const errorName = err?.name || 'NonErrorThrown';

        // 同一个异常在循环里反复抛出时，只记第一次，避免刷满日志
        const signature = `${errorName}|${message}|${stack?.split('\n')[1] ?? ''}`;
        const t = now();
        const last = uncaughtSeen.get(signature);
        if (last !== undefined && t - last < UNCAUGHT_DEDUPE_MS) return null;
        uncaughtSeen.set(signature, t);
        if (uncaughtSeen.size > 100) {
          const oldest = uncaughtSeen.keys().next().value;
          if (oldest !== undefined) uncaughtSeen.delete(oldest);
        }
        uncaughtCount++;

        const event: CrashEvent = {
          ...base('uncaught-exception'),
          errorName,
          message,
          ...(stack ? { stack } : {}),
          ...(origin ? { detail: origin } : {}),
        };
        return commit(event, 'error');
      } catch (handlerError) {
        console.error(
          '[crash] uncaught-exception handler failed:',
          handlerError,
        );
        return null;
      }
    },

    markShuttingDown() {
      shuttingDown = true;
    },

    setLogSink(next) {
      sink = next;
      if (!sink) return;
      for (const { message, level } of pendingLogs.splice(0)) {
        try {
          sink(message, level);
        } catch {
          // 同上：日志失败不影响其余
        }
      }
    },
  };
}
