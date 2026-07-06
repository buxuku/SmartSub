import { TaskCancelledError } from '../taskContext';

/**
 * 云 ASR 服务商级全局闸：并发信号量 + 请求起始间隔速率闸，按 provider 实例共享。
 *
 * 背景：任务级并发放开后，同一服务商的实际请求并发 = 并发任务数 × 任务内切片并发，
 * 会轻易突破服务商的 QPS / 并发路数配额（429 限流甚至封禁）。此闸把服务商设置里的
 * 「并发请求数 / 请求间隔」从"单任务内"语义提升为"跨任务全局"语义：
 *   - 同一 provider 的在途请求总数 ≤ concurrency（订单制服务商如讯飞，一次
 *     transcriber 调用=一个在途订单，占一个槽直到轮询结束——保守且符合并发路数配额）；
 *   - 任意两次请求的开始时刻间隔 ≥ requestInterval（跨任务统一排队）。
 *
 * 等待可被 AbortSignal 取消（抛 TaskCancelledError）；已预约的速率窗口不回收，
 * 取消后其它等待者最多多等一个 interval（换取实现简单，且始终不会更激进）。
 */
class CloudProviderGate {
  private limit = 1;
  private intervalMs = 0;
  private active = 0;
  private nextAllowedAt = 0;
  private waiters: Array<{
    grant: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  /** 每次转写前同步最新的服务商设置（用户可能中途改配置）。 */
  setLimits(concurrency: number, intervalMs: number): void {
    this.limit = Math.max(1, Math.floor(concurrency) || 1);
    this.intervalMs = Math.max(0, intervalMs || 0);
    this.drain();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    await this.acquireSlot(signal);
    try {
      await this.waitRateWindow(signal);
    } catch (error) {
      this.releaseSlot();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private acquireSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new TaskCancelledError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        grant: () => {
          this.active += 1;
          resolve();
        },
        reject,
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new TaskCancelledError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      next.grant();
    }
  }

  /** 近似速率闸：让全局请求的「开始时刻」间隔 ≥ intervalMs。 */
  private async waitRateWindow(signal?: AbortSignal): Promise<void> {
    if (this.intervalMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.intervalMs;
    if (wait <= 0) return;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new TaskCancelledError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, wait);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new TaskCancelledError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

const gates = new Map<string, CloudProviderGate>();

export function getCloudProviderGate(providerId: string): CloudProviderGate {
  let gate = gates.get(providerId);
  if (!gate) {
    gate = new CloudProviderGate();
    gates.set(providerId, gate);
  }
  return gate;
}
