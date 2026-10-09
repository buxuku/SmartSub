/**
 * 原生调用护栏：给会拖垮整个主进程的原生代码（whisper addon 的 dlopen 与转写）做记号，
 * 并向加载器回答“这个候选现在能不能用”。
 *
 * 在途标记同步写进运行状态文件：进程一旦崩溃，内核已经持有写入的数据，
 * 下次启动读到仍在的标记，就知道上次崩在什么上面（见 breaker.ts 的判定）。
 *
 * 回退开关：SMARTSUB_DISABLE_CRASH_BREAKER=true 关闭熔断（不写标记、不抑制、不对账）。
 * 状态与对账都发生在 runLifecycle.beginRun 里，这里只持有绑定后的引用。
 */
import {
  adoptGpu,
  emptyBreaker,
  findSuppression,
  pruneBreaker,
  recordSuccess,
  type BreakerEnv,
  type BreakerTable,
  type Strike,
  type Suppression,
} from './breaker';
import type { CrashLogSink } from './crashMonitor';
import type { InFlightMark, RunStateStore } from './runState';

export const DISABLE_BREAKER_ENV = 'SMARTSUB_DISABLE_CRASH_BREAKER';

interface Binding {
  store: RunStateStore;
  env: () => BreakerEnv;
  log?: CrashLogSink;
  now: () => number;
}

let binding: Binding | null = null;
let sequence = 0;

export function isBreakerDisabledByEnv(): boolean {
  return process.env[DISABLE_BREAKER_ENV] === 'true';
}

/** 由 runLifecycle.beginRun 调用：把护栏接到这一次运行的状态文件上。 */
export function bindNativeGuard(
  store: RunStateStore,
  env: () => BreakerEnv,
  log?: CrashLogSink,
  now: () => number = Date.now,
): void {
  binding = { store, env, log, now };
}

export function unbindNativeGuard(): void {
  binding = null;
  sequence = 0;
}

function active(): Binding | null {
  return binding && !isBreakerDisabledByEnv() ? binding : null;
}

export type NativeCallInfo = Omit<InFlightMark, 'callId' | 'startedAt'>;

/**
 * 原生调用开始前登记在途标记，返回结束时调用的函数（重复调用只生效一次）。
 * 未绑定（第二个实例、单测）或已关闭时什么也不做。
 */
export function beginNativeCall(info: NativeCallInfo): () => void {
  const bound = active();
  if (!bound) return () => {};
  const callId = `${process.pid}-${++sequence}`;
  bound.store.update((state) => {
    state.inFlight.push({ ...info, callId, startedAt: bound.now() });
  });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    bound.store.update((state) => {
      state.inFlight = state.inFlight.filter((mark) => mark.callId !== callId);
    });
  };
}

function save(bound: Binding, table: BreakerTable): void {
  bound.store.update((state) => {
    state.breaker = table;
  });
}

/**
 * 这个候选此刻是否被抑制。
 * 顺带清掉指纹已不成立的记录，并补上启动时还不知道的显卡指纹（gpu 由调用方在加载时给出）。
 */
export function lookupSuppression(
  key: string,
  gpu?: string,
): Suppression | null {
  const bound = active();
  if (!bound) return null;
  const env = { ...bound.env(), ...(gpu ? { gpu } : {}) };
  let table = bound.store.current().breaker;
  let changed = false;
  if (gpu) {
    const adopted = adoptGpu(table, gpu);
    if (adopted !== table) {
      table = adopted;
      changed = true;
    }
  }
  const pruned = pruneBreaker(table, env);
  if (pruned.dropped.length > 0) {
    table = pruned.table;
    changed = true;
    for (const dropped of pruned.dropped) {
      bound.log?.(
        `Crash breaker: ${dropped.kind} for ${dropped.key} cleared because the environment changed`,
        'info',
      );
    }
  }
  if (changed) save(bound, table);
  return findSuppression(table, key, env);
}

/** 一次原生转写顺利完成：这个候选的弱证据计数清零。 */
export function recordNativeSuccess(key: string): void {
  const bound = active();
  if (!bound) return;
  const table = bound.store.current().breaker;
  const next = recordSuccess(table, key);
  if (next !== table) save(bound, next);
}

/** 手动重置：清掉全部抑制与计数，返回清掉了多少条。 */
export function resetSuppressions(): number {
  if (!binding) return 0;
  const table = binding.store.current().breaker;
  const count = table.suppressions.length + table.strikes.length;
  if (count > 0) save(binding, emptyBreaker());
  return count;
}

export interface BreakerSnapshot {
  enabled: boolean;
  suppressions: Suppression[];
  strikes: Strike[];
}

/** 当前熔断表（界面与诊断包用）。 */
export function snapshotBreaker(): BreakerSnapshot {
  const enabled = !!active();
  if (!binding) return { enabled, suppressions: [], strikes: [] };
  const { suppressions, strikes } = binding.store.current().breaker;
  return { enabled, suppressions, strikes };
}
