/**
 * 运行状态文件 `{userData}/crash-state.json`：让“下一次启动”知道“上一次是怎么结束的”。
 *
 * 内容：本次运行的起止、是否正常退出、以及（M2 熔断用）正在调用原生代码的在途标记。
 * 不依赖 electron，路径由调用方给；所有写入都是同步的小文件（临时文件 + 改名），
 * 因为原生代码一旦崩溃，进程里没有任何机会再做异步收尾——但已经写进内核的数据不会丢。
 *
 * 读取对损坏、缺字段、版本不符一律宽容：返回 null（等同“不知道上次的情况”），
 * 绝不因为这个文件让应用起不来。
 */
import fs from 'fs';
import path from 'path';

export const RUN_STATE_VERSION = 1;

/** 一次正在进行的原生调用。进程崩溃后它还留在文件里，就是“崩在这里”的证据。 */
export interface InFlightMark {
  callId: string;
  /** 例：whisper-builtin、whisper-reference、dlopen（加载阶段） */
  engine: string;
  backend?: string;
  /** 只放模型名，不放路径 */
  model?: string;
  phase?: string;
  /** 候选 addon 的路径，用来把崩溃归到具体的后端（熔断按它抑制） */
  candidatePath?: string;
  startedAt: number;
}

export interface RunState {
  version: typeof RUN_STATE_VERSION;
  /** 上一次运行是否走完了正常退出流程 */
  cleanExit: boolean;
  startedAt: number;
  endedAt?: number;
  appVersion?: string;
  inFlight: InFlightMark[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseMark(value: unknown): InFlightMark | null {
  if (!isRecord(value)) return null;
  if (typeof value.callId !== 'string' || typeof value.engine !== 'string') {
    return null;
  }
  if (typeof value.startedAt !== 'number') return null;
  const mark: InFlightMark = {
    callId: value.callId,
    engine: value.engine,
    startedAt: value.startedAt,
  };
  for (const key of ['backend', 'model', 'phase', 'candidatePath'] as const) {
    const field = value[key];
    if (typeof field === 'string' && field) mark[key] = field;
  }
  return mark;
}

/** 解析并校验；不合格返回 null。 */
export function parseRunState(text: string): RunState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== RUN_STATE_VERSION) return null;
  if (typeof raw.cleanExit !== 'boolean') return null;
  if (typeof raw.startedAt !== 'number') return null;
  const inFlight = Array.isArray(raw.inFlight)
    ? raw.inFlight
        .map(parseMark)
        .filter((mark): mark is InFlightMark => mark !== null)
    : [];
  return {
    version: RUN_STATE_VERSION,
    cleanExit: raw.cleanExit,
    startedAt: raw.startedAt,
    ...(typeof raw.endedAt === 'number' ? { endedAt: raw.endedAt } : {}),
    ...(typeof raw.appVersion === 'string'
      ? { appVersion: raw.appVersion }
      : {}),
    inFlight,
  };
}

export function readRunState(file: string): RunState | null {
  try {
    return parseRunState(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 同步写：先写临时文件再改名。永不抛错，成功返回 true。 */
export function writeRunStateSync(file: string, state: RunState): boolean {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
    try {
      fs.renameSync(temp, file);
    } catch {
      // Windows 上目标被杀毒软件等短暂占用时改名可能失败：退回直接覆盖
      fs.writeFileSync(file, JSON.stringify(state), 'utf8');
      fs.rmSync(temp, { force: true });
    }
    return true;
  } catch (error) {
    console.error('[crash] failed to write run state:', error);
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 临时文件清不掉也不影响主流程
    }
    return false;
  }
}

export interface RunStateStore {
  /** 启动时读到的“上一次”状态；没有或损坏为 null */
  readonly previous: RunState | null;
  /** 当前运行的内存状态（返回副本，修改请走 update） */
  current(): RunState;
  /** 开始本次运行：写入 cleanExit=false，并清空在途标记 */
  markStarted(appVersion?: string): void;
  /** 走完正常退出流程：写入 cleanExit=true */
  markCleanExit(): void;
  /** 修改当前状态并立即同步落盘 */
  update(mutator: (state: RunState) => void): void;
}

export function createRunStateStore(
  file: string,
  now: () => number = Date.now,
): RunStateStore {
  const previous = readRunState(file);
  let state: RunState = {
    version: RUN_STATE_VERSION,
    cleanExit: false,
    startedAt: now(),
    inFlight: [],
  };
  const persist = () => {
    writeRunStateSync(file, state);
  };
  return {
    previous,
    current: () => ({ ...state, inFlight: [...state.inFlight] }),
    markStarted(appVersion) {
      state = {
        version: RUN_STATE_VERSION,
        cleanExit: false,
        startedAt: now(),
        ...(appVersion ? { appVersion } : {}),
        inFlight: [],
      };
      persist();
    },
    markCleanExit() {
      state = { ...state, cleanExit: true, endedAt: now() };
      persist();
    },
    update(mutator) {
      mutator(state);
      persist();
    },
  };
}
