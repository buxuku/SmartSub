/**
 * 带缓存的“单飞”：缓存未命中时，同时到达的调用共享同一次计算，而不是各自重复计算。
 *
 * 为什么需要：GPU 环境探测要起外部进程（Windows 上是 PowerShell / nvidia-smi），
 * 而应用启动期有好几处几乎同时调用它——主进程预热（background.ts）、渲染进程经 IPC 来问的
 * Layout 加速徽章 / 首次启动才出现的引导页 / 引擎与模型页，以及任务开始时的 addonLoader……
 * 只缓存“结果”、不缓存“进行中的探测”时，这些调用会各自再把整套外部进程起一遍。
 */
export interface SingleFlightCache<T> {
  /** 命中缓存直接返回；有探测在进行就加入它；否则开始一次新的探测。forceRefresh 一律重新探测。 */
  get(forceRefresh?: boolean): Promise<T>;
  /** 丢弃缓存，并让进行中的探测过期（它们的结果不再写入缓存）。 */
  clear(): void;
}

export function createSingleFlightCache<T>(
  compute: () => Promise<T>,
): SingleFlightCache<T> {
  // 包一层是为了让 falsy 的结果（0、''）也能被缓存
  let cached: { value: T } | null = null;
  let inflight: Promise<T> | null = null;
  // clear / 强制刷新会让更早开始的探测过期：结果仍还给各自的调用方，但不再写入缓存，
  // 避免一次慢的旧探测晚于新探测完成、把过期结果盖回缓存。
  let generation = 0;

  const start = (): Promise<T> => {
    const mine = ++generation;
    const tracked: Promise<T> = (async () => compute())()
      .then((value) => {
        if (mine === generation) cached = { value };
        return value;
      })
      .finally(() => {
        if (inflight === tracked) inflight = null;
      });
    inflight = tracked;
    return tracked;
  };

  return {
    get(forceRefresh = false) {
      if (!forceRefresh) {
        if (cached) return Promise.resolve(cached.value);
        if (inflight) return inflight;
      }
      return start();
    },
    clear() {
      cached = null;
      inflight = null;
      generation++;
    },
  };
}
