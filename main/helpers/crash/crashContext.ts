/**
 * 记录“应用此刻正在做什么”（引擎、后端、模型、阶段）。
 *
 * 崩溃事件与在途标记据此带上现场：只知道“某个 utilityProcess 崩了”不够，
 * 还要知道当时是哪个引擎、哪个模型、哪个后端在跑。
 *
 * 纯内存、不依赖 electron。并发任务各占一条，结束时移除，所以快照是数组而不是单个对象。
 */

export interface CrashContextEntry {
  /** 例：whisper-builtin、whisper-reference、sherpa-tts、sherpa-funasr、speaker-diarization */
  engine: string;
  /** 例：vulkan、cpu、metal、coreml、cuda 12.4.0、custom */
  backend?: string;
  /** 只放模型名，不放路径（路径里会带用户名） */
  model?: string;
  /** 例：transcribe、voice-clone-reference、synthesize */
  phase?: string;
  startedAt: number;
}

export type CrashContextInput = Omit<CrashContextEntry, 'startedAt'>;

const MAX_ENTRIES = 32;

const active = new Map<number, CrashContextEntry>();
let sequence = 0;

/** 去掉目录，只留文件名（兼容 Windows 与 POSIX 分隔符）。 */
function toLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const last = value.split(/[\\/]/).pop();
  return last || undefined;
}

/**
 * 登记一条现场信息，返回用于移除它的函数（可重复调用，只生效一次）。
 * 条目超过上限时丢弃最早的，防止调用方漏掉移除造成无限增长。
 */
export function beginCrashContext(
  input: CrashContextInput,
  now: number = Date.now(),
): () => void {
  const id = ++sequence;
  active.set(id, {
    engine: input.engine,
    ...(input.backend ? { backend: input.backend } : {}),
    ...(input.model ? { model: toLabel(input.model) } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    startedAt: now,
  });
  while (active.size > MAX_ENTRIES) {
    const oldest = active.keys().next().value;
    if (oldest === undefined) break;
    active.delete(oldest);
  }
  return () => {
    active.delete(id);
  };
}

/** 在执行期间登记现场，无论成功、失败还是同步抛错都会移除。 */
export async function withCrashContext<T>(
  input: CrashContextInput,
  run: () => Promise<T> | T,
): Promise<T> {
  const end = beginCrashContext(input);
  try {
    return await run();
  } finally {
    end();
  }
}

/** 当前所有进行中的现场（按开始时间升序）。 */
export function snapshotCrashContext(): CrashContextEntry[] {
  return [...active.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** 仅供测试。 */
export function resetCrashContextForTest(): void {
  active.clear();
  sequence = 0;
}
