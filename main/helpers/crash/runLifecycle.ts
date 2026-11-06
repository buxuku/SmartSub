/**
 * 一次运行的生命周期：启动时回顾“上一次是怎么结束的”，退出时记下“这次正常结束了”。
 *
 * 不依赖 electron（路径、版本由调用方传入），本模块持有进程内唯一的运行状态；
 * 被 crashReporting 在 app ready 之后调用——此时已抢到单实例锁，第二个实例不会走到这里，
 * 不会把主实例的状态文件改乱。
 */
import type {
  PreviousRunNotice,
  PreviousRunSuppressed,
} from '../../../types/diagnostics';
import {
  describeBreakerChange,
  emptyBreaker,
  reconcileBreaker,
  type BreakerEnv,
  type BreakerTable,
} from './breaker';
import { listDumpFiles } from './crashDumps';
import { appendCrashEvent, readCrashEvents } from './crashEvents';
import type { CrashLogSink } from './crashMonitor';
import { summarizeMinidumpFile } from './minidumpSummary';
import { assessPreviousRun, type PreviousRunAssessment } from './previousRun';
import {
  bindNativeGuard,
  isBreakerDisabledByEnv,
  unbindNativeGuard,
} from './nativeGuard';
import { createRunStateStore, type RunStateStore } from './runState';

export interface BeginRunOptions {
  stateFile: string;
  dumpsDir: string;
  eventsFile: string;
  appVersion: string;
  platform: string;
  arch: string;
  log?: CrashLogSink;
  now?: () => number;
  /** 熔断用的环境信息；缺省表示不启用熔断 */
  breakerEnv?: () => BreakerEnv;
}

let store: RunStateStore | null = null;
let pendingNotice: PreviousRunNotice | null = null;
let lastAssessment: PreviousRunAssessment | null = null;

/**
 * 回顾上一次运行并开始本次运行。必须在清理转储与事件之前调用（清理会删掉证据）。
 * 任何失败都只打印：状态跟踪不能让应用起不来。
 */
export function beginRun(
  options: BeginRunOptions,
): PreviousRunAssessment | null {
  const now = options.now ?? Date.now;
  let assessment: PreviousRunAssessment | null = null;
  let breaker: BreakerTable | undefined;
  const suppressed: PreviousRunSuppressed[] = [];
  try {
    store = createRunStateStore(options.stateFile, now);
    const previous = store.previous;
    // 上次正常退出（或没有记录）时没有要找的证据，省掉枚举转储与读事件的开销
    const abnormal = !!previous && !previous.cleanExit;
    assessment = assessPreviousRun({
      previous,
      now: now(),
      dumps: abnormal ? listDumpFiles(options.dumpsDir) : [],
      summarize: (file) => summarizeMinidumpFile(file),
      events: abnormal
        ? readCrashEvents(options.eventsFile, { sinceTs: previous.startedAt })
        : [],
      appVersion: options.appVersion,
      platform: options.platform,
      arch: options.arch,
    });
    if (assessment.event)
      appendCrashEvent(options.eventsFile, assessment.event);
    if (assessment.log) {
      options.log?.(assessment.log.message, assessment.log.level);
    }

    // 把上次的证据并入熔断表。只在能拿到环境信息、且没被关掉时做。
    if (options.breakerEnv && !isBreakerDisabledByEnv()) {
      try {
        const result = reconcileBreaker(
          previous?.breaker ?? emptyBreaker(),
          assessment,
          options.breakerEnv(),
          now(),
        );
        breaker = result.table;
        for (const change of result.changes) {
          const line = describeBreakerChange(change);
          options.log?.(line.message, line.level);
          if (change.kind === 'suppressed') {
            const s = change.suppression;
            suppressed.push({ scope: s.scope, reason: s.reason, key: s.key });
          }
        }
      } catch (error) {
        console.error('[crash] failed to reconcile the crash breaker:', error);
      }
    }

    pendingNotice = assessment.notice
      ? {
          ...assessment.notice,
          ...(suppressed.length ? { suppressed } : {}),
        }
      : null;
    lastAssessment = assessment;
  } catch (error) {
    console.error('[crash] failed to assess the previous run:', error);
  }
  try {
    store?.markStarted(options.appVersion, breaker);
    if (store && options.breakerEnv) {
      bindNativeGuard(store, options.breakerEnv, options.log, now);
    }
  } catch (error) {
    console.error('[crash] failed to record the run start:', error);
  }
  return assessment;
}

/** 走完正常退出流程。没有 beginRun 过（例如第二个实例）时什么也不做。 */
export function markCleanExit(): void {
  try {
    store?.markCleanExit();
  } catch (error) {
    console.error('[crash] failed to record the clean exit:', error);
  }
}

export function getRunStateStore(): RunStateStore | null {
  return store;
}

/** 启动时对上一次运行的判断结果（仅用于熔断与诊断）。 */
export function getPreviousRunAssessment(): PreviousRunAssessment | null {
  return lastAssessment;
}

/** 给用户看的一次性提示；没有证据时为 null。渲染进程主动来取（拉取式，不怕窗口还没就绪）。 */
export function getPreviousRunNotice(): PreviousRunNotice | null {
  return pendingNotice;
}

export function dismissPreviousRunNotice(): void {
  pendingNotice = null;
}

/** 仅供单测：清掉进程内的单例状态。 */
export function resetRunLifecycleForTests(): void {
  unbindNativeGuard();
  store = null;
  pendingNotice = null;
  lastAssessment = null;
}
