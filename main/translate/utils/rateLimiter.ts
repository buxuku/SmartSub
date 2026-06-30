/**
 * 客户端限速器（主进程内存级，按 providerId 维度）
 *
 * 免费翻译源没有官方额度，真正的约束是按 IP 的软限流（429）。这里提供：
 * - 最小请求间隔（minIntervalMs）：保证相邻请求之间至少间隔指定毫秒数
 * - 滑动窗口（windowMs + maxInWindow）：窗口内最多放行 maxInWindow 次请求
 *
 * 通过 per-key 的异步互斥串行化，避免并发任务击穿限速。
 */

import {
  throwIfSignalCancelled,
  waitForTaskDelay,
} from '../../helpers/taskContext';

export interface RateLimitConfig {
  /** 相邻请求最小间隔（毫秒），<=0 表示不限制 */
  minIntervalMs?: number;
  /** 滑动窗口长度（毫秒），需与 maxInWindow 同时 > 0 才生效 */
  windowMs?: number;
  /** 滑动窗口内允许的最大请求数 */
  maxInWindow?: number;
}

const lastCallAt: Record<string, number> = {};
const windowHits: Record<string, number[]> = {};
/** per-key 互斥链，保证同一 key 的 acquire 串行执行 */
const locks: Record<string, Promise<void>> = {};

/**
 * 申请一次放行额度，必要时 await 到允许发起请求的时刻。
 * 调用方应在真正发起网络请求前 await 本函数。
 */
export async function acquire(
  key: string,
  cfg: RateLimitConfig = {},
  signal?: AbortSignal,
): Promise<void> {
  throwIfSignalCancelled(signal);
  const prev = locks[key] ?? Promise.resolve();
  let release!: () => void;
  locks[key] = new Promise<void>((resolve) => {
    release = resolve;
  });

  // 等待前一个同 key 的请求完成排队
  await prev;

  try {
    throwIfSignalCancelled(signal);
    const { minIntervalMs = 0, windowMs = 0, maxInWindow = 0 } = cfg;

    // 1) 最小间隔
    if (minIntervalMs > 0) {
      const wait = (lastCallAt[key] ?? 0) + minIntervalMs - Date.now();
      if (wait > 0) await waitForTaskDelay(wait, signal);
    }

    // 2) 滑动窗口
    if (windowMs > 0 && maxInWindow > 0) {
      let hits = windowHits[key] ?? [];
      hits = hits.filter((t) => t > Date.now() - windowMs);
      while (hits.length >= maxInWindow) {
        const waitFor = hits[0] + windowMs - Date.now();
        if (waitFor > 0) await waitForTaskDelay(waitFor, signal);
        hits = hits.filter((t) => t > Date.now() - windowMs);
      }
      hits.push(Date.now());
      windowHits[key] = hits;
    }

    lastCallAt[key] = Date.now();
  } finally {
    release();
  }
}

/** 将 fn 包裹在限速器内执行 */
export async function withRateLimit<T>(
  key: string,
  cfg: RateLimitConfig,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await acquire(key, cfg, signal);
  return fn();
}

/**
 * 从 provider 配置解析限速参数：
 * - requestInterval（秒）→ minIntervalMs
 * - windowMaxRequests（次/60s）→ 滑动窗口
 */
export function resolveRateLimitConfig(proof: any): RateLimitConfig {
  const minIntervalMs = Math.round(
    (Number(proof?.requestInterval) || 0) * 1000,
  );
  const maxInWindow = Number(proof?.windowMaxRequests) || 0;
  return {
    minIntervalMs,
    windowMs: maxInWindow > 0 ? 60_000 : 0,
    maxInWindow,
  };
}
