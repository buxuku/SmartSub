/**
 * 子进程 / 渲染进程退出分类（纯函数，不依赖 electron，便于单测）。
 *
 * 依据 PoC 在 windows-latest、ubuntu-24.04、macOS arm64 上的实测：
 * - Windows：崩溃的退出码是 NTSTATUS。只有主进程启动了 crashReporter，真实异常码才会保留；
 *   否则 Crashpad 会把它改写成 0xFFFF70xx（0xFFFF7003 = 未连接），非法指令与访问违例无法区分。
 *   对负数形式的 NTSTATUS（有符号 32 位）要先 >>> 0 再查表。
 * - Linux / macOS：被信号杀死时退出码等于信号编号；Linux 上进程产生了 core dump 时是原始
 *   wait status（bit7 = 已 core dump，例如 SIGABRT 无 dump 为 6、有 dump 为 134）。
 * - 一律以 child-process-gone 的 exitCode 与 reason 为准；自己 kill 的打 killedByUs，不参与分类
 *   （实测 macOS 父进程 kill 之后 exit code 是垃圾值）。
 */

export type ExitKind =
  | 'clean'
  | 'killed-by-us'
  | 'killed'
  | 'oom'
  | 'illegal-instruction'
  | 'access-violation'
  | 'abort'
  | 'fast-fail'
  | 'stack-overflow'
  | 'heap-corruption'
  | 'arithmetic'
  | 'breakpoint'
  | 'dll-not-found'
  | 'crashpad-lost-code'
  | 'launch-failed'
  | 'integrity-failure'
  | 'crash-unknown'
  | 'exit-nonzero';

export interface ExitInfo {
  platform?: NodeJS.Platform;
  /** child-process-gone / render-process-gone 的 exitCode，或进程 exit 事件里的 code */
  exitCode?: number | null;
  /** Electron 给出的原因：clean-exit | abnormal-exit | killed | crashed | oom | launch-failed | integrity-failure | memory-eviction */
  reason?: string;
  /** 是我们自己 kill 的（此时退出码不可信） */
  killedByUs?: boolean;
}

export interface ExitClassification {
  kind: ExitKind;
  /** 按“崩溃”对待：会写崩溃事件，也可作为熔断的证据之一 */
  isCrash: boolean;
  /** 本机 CPU 指令集不满足（SIGILL / 0xC000001D）：换同族 addon 没有意义 */
  isIsa: boolean;
  /** 需要记录的异常结局（clean 与 killed-by-us 以外都算） */
  abnormal: boolean;
  /** 简短的可读标签，例如 ILLEGAL_INSTRUCTION、SIGSEGV */
  label: string;
  /** Windows 的 NTSTATUS（0xC000001D 形式） */
  code?: string;
  /** POSIX 的信号名 */
  signal?: string;
  /** Linux：已 core dump（wait status bit7） */
  core?: boolean;
  /** 崩溃了，但真实异常码因 crashReporter 未连接而丢失（Windows 的 0xFFFF70xx） */
  realCodeLost?: boolean;
}

interface NamedStatus {
  kind: ExitKind;
  label: string;
}

// Windows NTSTATUS。0xC000001D 与 0xC0000005 已在 windows-latest 上实测。
const WINDOWS_STATUS: Record<number, NamedStatus> = {
  0xc000001d: { kind: 'illegal-instruction', label: 'ILLEGAL_INSTRUCTION' },
  0xc0000005: { kind: 'access-violation', label: 'ACCESS_VIOLATION' },
  0xc0000409: { kind: 'fast-fail', label: 'FAST_FAIL' },
  0xc00000fd: { kind: 'stack-overflow', label: 'STACK_OVERFLOW' },
  0xc0000374: { kind: 'heap-corruption', label: 'HEAP_CORRUPTION' },
  0xc0000094: { kind: 'arithmetic', label: 'INT_DIVIDE_BY_ZERO' },
  0xc0000095: { kind: 'arithmetic', label: 'INT_OVERFLOW' },
  0xc000008e: { kind: 'arithmetic', label: 'FLT_DIVIDE_BY_ZERO' },
  0xc0000090: { kind: 'arithmetic', label: 'FLT_INVALID_OPERATION' },
  0xc0000091: { kind: 'arithmetic', label: 'FLT_OVERFLOW' },
  0xc0000096: { kind: 'crash-unknown', label: 'PRIV_INSTRUCTION' },
  0xc0000135: { kind: 'dll-not-found', label: 'DLL_NOT_FOUND' },
  0xc0000142: { kind: 'dll-not-found', label: 'DLL_INIT_FAILED' },
  0x80000003: { kind: 'breakpoint', label: 'BREAKPOINT' },
};

// Crashpad 的终止码（crashpad/util/win/termination_codes.h，已对照源码）。
const CRASHPAD_STATUS: Record<number, string> = {
  0xffff7001: 'CRASHPAD_NO_DUMP',
  0xffff7002: 'CRASHPAD_SNAPSHOT_FAILED',
  0xffff7003: 'CRASHPAD_NOT_CONNECTED',
};

// Windows 上外部结束进程的常见码（Ctrl+C / 任务管理器结束任务通常是 1 或 0xC000013A）。
const WINDOWS_KILLED = new Set([0xc000013a]);

// Node 的 process.abort() 在 Windows 上实现为 _exit(134)：不是异常，也不会产生 dump（PoC 实测）。
const NODE_ABORT_CODE = 134;

// 信号编号 → 名称。Linux 与 macOS 在 7 / 10 号上不同，所以分别列出。
const LINUX_SIGNALS: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  7: 'SIGBUS',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  15: 'SIGTERM',
  31: 'SIGSYS',
};
const DARWIN_SIGNALS: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  7: 'SIGEMT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  10: 'SIGBUS',
  11: 'SIGSEGV',
  12: 'SIGSYS',
  13: 'SIGPIPE',
  15: 'SIGTERM',
};

const SIGNAL_KINDS: Record<string, ExitKind> = {
  SIGILL: 'illegal-instruction',
  SIGSEGV: 'access-violation',
  SIGBUS: 'access-violation',
  SIGABRT: 'abort',
  SIGFPE: 'arithmetic',
  SIGTRAP: 'breakpoint',
  SIGEMT: 'crash-unknown',
  SIGSYS: 'crash-unknown',
};

const KILL_SIGNALS = new Set(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP']);

export function formatNtStatus(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function buildClassification(
  kind: ExitKind,
  label: string,
  extra: Partial<ExitClassification> = {},
): ExitClassification {
  const isCrash = !['clean', 'killed-by-us', 'killed', 'exit-nonzero'].includes(
    kind,
  );
  return {
    kind,
    isCrash,
    isIsa: kind === 'illegal-instruction',
    abnormal: kind !== 'clean' && kind !== 'killed-by-us',
    label,
    ...extra,
  };
}

function classifyWindows(
  raw: number | null,
  reason: string | undefined,
): ExitClassification {
  if (raw !== null && Number.isFinite(raw)) {
    const unsigned = raw >>> 0;
    const named = WINDOWS_STATUS[unsigned];
    if (named) {
      return buildClassification(named.kind, named.label, {
        code: formatNtStatus(unsigned),
      });
    }
    const crashpad = CRASHPAD_STATUS[unsigned];
    if (crashpad) {
      // 崩溃是真的，只是真实异常码丢了：Windows 没启用 crashReporter 时就是这样。
      return buildClassification('crashpad-lost-code', crashpad, {
        code: formatNtStatus(unsigned),
        realCodeLost: true,
      });
    }
    if (WINDOWS_KILLED.has(unsigned)) {
      return buildClassification('killed', 'CONTROL_C_EXIT', {
        code: formatNtStatus(unsigned),
      });
    }
    if (raw === NODE_ABORT_CODE && reason !== 'clean-exit') {
      return buildClassification('abort', 'NODE_ABORT', { code: String(raw) });
    }
  }
  if (reason === 'oom' || reason === 'memory-eviction') {
    return buildClassification('oom', 'OUT_OF_MEMORY');
  }
  if (reason === 'launch-failed')
    return buildClassification('launch-failed', 'LAUNCH_FAILED');
  if (reason === 'integrity-failure') {
    return buildClassification('integrity-failure', 'INTEGRITY_FAILURE');
  }
  if (reason === 'crashed') {
    return buildClassification('crash-unknown', 'CRASHED', {
      code:
        raw !== null && Number.isFinite(raw) ? formatNtStatus(raw) : undefined,
    });
  }
  if (reason === 'killed') return buildClassification('killed', 'KILLED');
  if (raw === 0 || reason === 'clean-exit')
    return buildClassification('clean', 'CLEAN_EXIT');
  return buildClassification('exit-nonzero', 'EXIT_NONZERO', {
    code: raw !== null ? String(raw) : undefined,
  });
}

function classifyPosix(
  platform: NodeJS.Platform,
  raw: number | null,
  reason: string | undefined,
): ExitClassification {
  const table = platform === 'darwin' ? DARWIN_SIGNALS : LINUX_SIGNALS;
  let signal: string | undefined;
  let core = false;
  if (raw !== null && Number.isFinite(raw) && raw > 0) {
    // 原始 wait status：低 7 位是信号编号，bit7 是 core dump 标志；裸信号编号时 raw <= 127。
    const decoded = raw > 127 ? raw & 0x7f : raw;
    core = raw > 127 && (raw & 0x80) !== 0;
    signal = table[decoded];
  }
  const extra: Partial<ExitClassification> = {};
  if (signal) extra.signal = signal;
  if (core) extra.core = true;

  if (reason === 'oom' || reason === 'memory-eviction') {
    return buildClassification('oom', 'OUT_OF_MEMORY', extra);
  }
  if (reason === 'launch-failed') {
    return buildClassification('launch-failed', 'LAUNCH_FAILED', extra);
  }
  if (reason === 'integrity-failure') {
    return buildClassification('integrity-failure', 'INTEGRITY_FAILURE', extra);
  }
  const crashKind = signal ? SIGNAL_KINDS[signal] : undefined;
  // Chromium 的 abnormal-exit 是“进程自己以非零码退出”，不是被信号杀死，所以有 reason 时
  // 只信 reason；只有没拿到 gone 事件（reason 缺失）时才退回信号表。
  const hasReason = typeof reason === 'string' && reason.length > 0;
  if (reason === 'crashed' || (!hasReason && crashKind)) {
    return buildClassification(
      crashKind ?? 'crash-unknown',
      signal ?? `CODE_${raw}`,
      extra,
    );
  }
  if (
    reason === 'killed' ||
    (!hasReason && signal && KILL_SIGNALS.has(signal))
  ) {
    return buildClassification('killed', signal ?? 'KILLED', extra);
  }
  if (raw === 0 || reason === 'clean-exit')
    return buildClassification('clean', 'CLEAN_EXIT');
  return buildClassification('exit-nonzero', 'EXIT_NONZERO', {
    ...extra,
    code: raw !== null ? String(raw) : undefined,
  });
}

export function classifyExit(info: ExitInfo): ExitClassification {
  // 自己 kill 的：退出码是垃圾值，不能拿来分类。
  if (info.killedByUs)
    return buildClassification('killed-by-us', 'KILLED_BY_APP');
  const platform = info.platform ?? process.platform;
  const raw =
    typeof info.exitCode === 'number' && Number.isFinite(info.exitCode)
      ? info.exitCode
      : null;
  return platform === 'win32'
    ? classifyWindows(raw, info.reason)
    : classifyPosix(platform, raw, info.reason);
}

/** 写进日志的一行描述，例如 `illegal-instruction (ILLEGAL_INSTRUCTION 0xC000001D)` */
export function describeExit(c: ExitClassification): string {
  const detail = [c.label, c.code, c.core ? 'core-dumped' : undefined]
    .filter(Boolean)
    .join(' ');
  return detail ? `${c.kind} (${detail})` : c.kind;
}
