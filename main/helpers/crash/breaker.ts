/**
 * 崩溃循环熔断：把“上次崩在哪个 whisper 加速包上”变成“这次不再加载它”。
 *
 * whisper addon 跑在 Electron 主进程里，一旦原生代码崩溃（典型是 CPU 缺 AVX2 导致的非法指令），
 * 应用整个闪退；用户重开、再点转写，又是同样的崩溃——没有熔断就是无限循环。
 *
 * 证据分两档：
 *   强证据：上次异常退出时某次原生调用还在进行（在途标记还在），并且在它开始之后出现了新转储。
 *           崩溃是确凿的，抑制 1 次就生效。
 *   弱证据：只有在途标记、没有转储（强杀、转储没写成、被系统杀掉都会这样）。
 *           同一候选连续 2 次才抑制；其间任何一次成功的调用都会清零。
 * 转储摘要为非法指令（0xC000001D / SIGILL）且是 x64 的预编译加速包时，整个预编译族一并抑制：
 * 它们共用同一套 AVX2 基线，换成 vulkan 或 cuda 也一样崩（QEMU 上已用真实 addon 验证过 Linux 版）。
 *
 * 抑制记录带“指纹”：addon 文件、CPU 型号、系统版本、显卡与驱动、应用版本，任一变化都自动失效，
 * 所以升级、换机、更新驱动之后会重新尝试一次。设置里也能手动重置。
 *
 * 纯函数、不依赖 electron：环境由调用方传入。
 */
import type { InFlightMark } from './runState';
import type { PreviousRunAssessment } from './previousRun';

export const WEAK_STRIKE_LIMIT = 2;

/**
 * 转储的修改时间可能比在途标记的开始时间早一点点：FAT / exFAT 的时间精度是 2 秒。
 * 留出这点余量，避免崩得太快的那次被判成“没有转储”。
 */
export const DUMP_CLOCK_SLACK_MS = 2000;

/** 预编译加速包族的抑制键（x64 上 builtin 与 userData 下载的 CUDA / Vulkan 都属于它）。 */
export const FAMILY_KEY = 'whisper-x64-prebuilt';

export type SuppressionScope = 'family' | 'candidate';
export type SuppressionReason = 'isa' | 'crash';
export type SuppressionEvidence = 'strong' | 'weak';

export interface AddonFileFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * 抑制记录失效的条件。字段缺省表示“没记录、不比较”；
 * gpu 在启动时拿不到（探测要跑外部命令），等第一次加载 addon 时补上，见 adoptGpu。
 */
export interface BreakerFingerprint {
  cpuModel?: string;
  osRelease?: string;
  appVersion?: string;
  gpu?: string;
  addon?: AddonFileFingerprint;
}

export interface Suppression {
  scope: SuppressionScope;
  key: string;
  reason: SuppressionReason;
  evidence: SuppressionEvidence;
  since: number;
  fingerprint: BreakerFingerprint;
  /** 触发抑制的崩溃，给人看的一句话，例如 illegal-instruction (ILLEGAL_INSTRUCTION 0xC000001D) */
  detail?: string;
}

export interface Strike {
  key: string;
  count: number;
  lastAt: number;
  fingerprint: BreakerFingerprint;
}

export interface BreakerTable {
  suppressions: Suppression[];
  strikes: Strike[];
}

export interface BreakerEnv {
  platform: string;
  arch: string;
  cpuModel?: string;
  osRelease?: string;
  appVersion?: string;
  /** 显卡与驱动；启动时通常还不知道 */
  gpu?: string;
  /** 读取文件的大小与修改时间；文件不存在返回 null */
  statFile(path: string): { size: number; mtimeMs: number } | null;
}

export function emptyBreaker(): BreakerTable {
  return { suppressions: [], strikes: [] };
}

/**
 * 候选的稳定键：`来源:后端[:变体]`，例如 builtin:vulkan、userData:cuda:12.4.0、custom:custom。
 * 不含路径（路径里会有用户名），诊断包与日志里可以直接出现。
 */
export function candidateKey(
  source: string,
  backend: string,
  variant?: string | null,
): string {
  return [source, backend, variant && variant !== backend ? variant : null]
    .filter(Boolean)
    .join(':');
}

/** 用户自己提供的 addon 不属于预编译族：编译参数我们不知道。 */
export function isFamilyKey(key: string): boolean {
  return !key.startsWith('custom:');
}

/** 需要显卡信息参与指纹的候选。 */
export function usesGpu(key: string): boolean {
  return /:(vulkan|cuda)(:|$)/.test(key);
}

// ───────────────────────────── 解析（状态文件可能损坏） ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function parseFingerprint(value: unknown): BreakerFingerprint {
  if (!isRecord(value)) return {};
  const out: BreakerFingerprint = {};
  const cpuModel = str(value.cpuModel);
  const osRelease = str(value.osRelease);
  const appVersion = str(value.appVersion);
  const gpu = str(value.gpu);
  if (cpuModel) out.cpuModel = cpuModel;
  if (osRelease) out.osRelease = osRelease;
  if (appVersion) out.appVersion = appVersion;
  if (gpu) out.gpu = gpu;
  const addon = value.addon;
  if (
    isRecord(addon) &&
    typeof addon.path === 'string' &&
    typeof addon.size === 'number' &&
    typeof addon.mtimeMs === 'number'
  ) {
    out.addon = {
      path: addon.path,
      size: addon.size,
      mtimeMs: addon.mtimeMs,
    };
  }
  return out;
}

function parseSuppression(value: unknown): Suppression | null {
  if (!isRecord(value)) return null;
  const { scope, reason, evidence } = value;
  if (scope !== 'family' && scope !== 'candidate') return null;
  if (reason !== 'isa' && reason !== 'crash') return null;
  if (evidence !== 'strong' && evidence !== 'weak') return null;
  const key = str(value.key);
  if (!key || typeof value.since !== 'number') return null;
  const detail = str(value.detail);
  return {
    scope,
    key,
    reason,
    evidence,
    since: value.since,
    fingerprint: parseFingerprint(value.fingerprint),
    ...(detail ? { detail } : {}),
  };
}

function parseStrike(value: unknown): Strike | null {
  if (!isRecord(value)) return null;
  const key = str(value.key);
  if (!key) return null;
  if (typeof value.count !== 'number' || value.count < 1) return null;
  if (typeof value.lastAt !== 'number') return null;
  return {
    key,
    count: Math.floor(value.count),
    lastAt: value.lastAt,
    fingerprint: parseFingerprint(value.fingerprint),
  };
}

/** 宽容解析：坏的条目直接丢弃，整体不合格就当作空表。 */
export function parseBreaker(value: unknown): BreakerTable {
  if (!isRecord(value)) return emptyBreaker();
  const suppressions = Array.isArray(value.suppressions)
    ? value.suppressions
        .map(parseSuppression)
        .filter((s): s is Suppression => s !== null)
    : [];
  const strikes = Array.isArray(value.strikes)
    ? value.strikes.map(parseStrike).filter((s): s is Strike => s !== null)
    : [];
  return { suppressions, strikes };
}

// ───────────────────────────── 指纹 ─────────────────────────────

function sameOrUnrecorded<T>(stored: T | undefined, current: T | undefined) {
  return stored === undefined || stored === current;
}

/** 记录下来的指纹是否仍然成立。只比较记录里有的字段；gpu 未记录视为“待补”，不算不一致。 */
export function fingerprintHolds(
  stored: BreakerFingerprint,
  env: BreakerEnv,
): boolean {
  if (!sameOrUnrecorded(stored.cpuModel, env.cpuModel)) return false;
  if (!sameOrUnrecorded(stored.osRelease, env.osRelease)) return false;
  if (!sameOrUnrecorded(stored.appVersion, env.appVersion)) return false;
  // gpu：启动时没记录的由 adoptGpu 补上；记录了却和现在不同才算变化。
  // 现在还不知道 gpu（env.gpu 缺省）时不下结论，保持记录。
  if (stored.gpu !== undefined && env.gpu !== undefined) {
    if (stored.gpu !== env.gpu) return false;
  }
  if (stored.addon) {
    const stat = env.statFile(stored.addon.path);
    if (
      !stat ||
      stat.size !== stored.addon.size ||
      stat.mtimeMs !== stored.addon.mtimeMs
    ) {
      return false;
    }
  }
  return true;
}

function buildFingerprint(
  env: BreakerEnv,
  parts: {
    osRelease: boolean;
    appVersion: boolean;
    addonPath?: string;
  },
): BreakerFingerprint {
  const out: BreakerFingerprint = {};
  if (env.cpuModel) out.cpuModel = env.cpuModel;
  if (parts.osRelease && env.osRelease) out.osRelease = env.osRelease;
  if (parts.appVersion && env.appVersion) out.appVersion = env.appVersion;
  if (parts.addonPath) {
    const stat = env.statFile(parts.addonPath);
    if (stat) {
      out.addon = {
        path: parts.addonPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    }
  }
  return out;
}

export interface PruneResult {
  table: BreakerTable;
  /** 因指纹变化而失效的记录（用来写日志） */
  dropped: Array<{ kind: 'suppression' | 'strike'; key: string }>;
}

/** 去掉指纹已不成立的抑制与计数。 */
export function pruneBreaker(
  table: BreakerTable,
  env: BreakerEnv,
): PruneResult {
  const dropped: PruneResult['dropped'] = [];
  const suppressions = table.suppressions.filter((s) => {
    const ok = fingerprintHolds(s.fingerprint, env);
    if (!ok) dropped.push({ kind: 'suppression', key: s.key });
    return ok;
  });
  const strikes = table.strikes.filter((s) => {
    const ok = fingerprintHolds(s.fingerprint, env);
    if (!ok) dropped.push({ kind: 'strike', key: s.key });
    return ok;
  });
  return { table: { suppressions, strikes }, dropped };
}

// ───────────────────────────── 查询与更新 ─────────────────────────────

/**
 * 某个候选此刻是否被抑制。族级抑制只对 x64 的预编译候选生效。
 * 不修改表；失效的记录请先 pruneBreaker。
 */
export function findSuppression(
  table: BreakerTable,
  key: string,
  env: Pick<BreakerEnv, 'arch'>,
): Suppression | null {
  if (env.arch === 'x64' && isFamilyKey(key)) {
    const family = table.suppressions.find(
      (s) => s.scope === 'family' && s.key === FAMILY_KEY,
    );
    if (family) return family;
  }
  return (
    table.suppressions.find((s) => s.scope === 'candidate' && s.key === key) ??
    null
  );
}

/** 一次原生调用成功完成：这个候选的弱证据计数清零。 */
export function recordSuccess(table: BreakerTable, key: string): BreakerTable {
  if (!table.strikes.some((s) => s.key === key)) return table;
  return {
    ...table,
    strikes: table.strikes.filter((s) => s.key !== key),
  };
}

/**
 * 补上启动时还不知道的显卡指纹（只补缺省的，且只补用得到显卡的候选）。
 * 没有需要补的就原样返回同一个对象，调用方据此判断要不要落盘。
 */
export function adoptGpu(table: BreakerTable, gpu: string): BreakerTable {
  let changed = false;
  const fill = <T extends { key: string; fingerprint: BreakerFingerprint }>(
    item: T,
  ): T => {
    if (!usesGpu(item.key) || item.fingerprint.gpu !== undefined) return item;
    changed = true;
    return { ...item, fingerprint: { ...item.fingerprint, gpu } };
  };
  const next: BreakerTable = {
    suppressions: table.suppressions.map(fill),
    strikes: table.strikes.map(fill),
  };
  return changed ? next : table;
}

// ───────────────────────────── 对账：上次的证据 → 抑制 ─────────────────────────────

export type BreakerChange =
  | { kind: 'suppressed'; suppression: Suppression }
  | { kind: 'strike'; key: string; count: number }
  | { kind: 'dropped'; what: 'suppression' | 'strike'; key: string };

export interface ReconcileResult {
  table: BreakerTable;
  changes: BreakerChange[];
}

function upsertSuppression(
  table: BreakerTable,
  next: Suppression,
): BreakerTable {
  const rest = table.suppressions.filter(
    (s) => !(s.scope === next.scope && s.key === next.key),
  );
  return { ...table, suppressions: [...rest, next] };
}

function isWhisperMark(
  mark: InFlightMark,
): mark is InFlightMark & { candidateKey: string } {
  return mark.engine.startsWith('whisper') && !!mark.candidateKey;
}

/**
 * 启动时把上一次的证据并入抑制表。
 * 只处理“异常退出”的那一次：正常退出时留下的标记没有意义（原生线程还在跑就退出了而已）。
 */
export function reconcileBreaker(
  table: BreakerTable,
  assessment: Pick<PreviousRunAssessment, 'status' | 'inFlight' | 'newDumps'>,
  env: BreakerEnv,
  now: number,
): ReconcileResult {
  const pruned = pruneBreaker(table, env);
  let current = pruned.table;
  const changes: BreakerChange[] = pruned.dropped.map((d) => ({
    kind: 'dropped' as const,
    what: d.kind,
    key: d.key,
  }));
  if (assessment.status !== 'abnormal') return { table: current, changes };

  for (const mark of assessment.inFlight.filter(isWhisperMark)) {
    const key = mark.candidateKey;
    // 这次崩溃之后的转储才算数：在途标记开始之前的转储是更早的事
    const dumps = assessment.newDumps.filter(
      (d) => d.mtimeMs >= mark.startedAt - DUMP_CLOCK_SLACK_MS,
    );
    const strong = dumps.length > 0;
    const isa = dumps.find((d) => d.classification?.isIsa)?.classification;
    const crashed = dumps.find(
      (d) => d.classification?.isCrash,
    )?.classification;
    const detailOf = (c: typeof isa) =>
      c
        ? `${c.kind} (${[c.label, c.code].filter(Boolean).join(' ')})`
        : undefined;

    // 这个候选已经被抑制着（例如整族）：不重复记录
    if (findSuppression(current, key, env)) continue;

    if (strong) {
      const familyIsa = !!isa && env.arch === 'x64' && isFamilyKey(key);
      const suppression: Suppression = familyIsa
        ? {
            scope: 'family',
            key: FAMILY_KEY,
            reason: 'isa',
            evidence: 'strong',
            since: now,
            fingerprint: buildFingerprint(env, {
              osRelease: false,
              appVersion: true,
              addonPath: mark.candidatePath,
            }),
            detail: detailOf(isa),
          }
        : {
            scope: 'candidate',
            key,
            reason: isa ? 'isa' : 'crash',
            evidence: 'strong',
            since: now,
            fingerprint: buildFingerprint(env, {
              osRelease: true,
              appVersion: false,
              addonPath: mark.candidatePath,
            }),
            detail: detailOf(isa ?? crashed),
          };
      if (!suppression.detail) delete suppression.detail;
      current = upsertSuppression(
        { ...current, strikes: current.strikes.filter((s) => s.key !== key) },
        suppression,
      );
      changes.push({ kind: 'suppressed', suppression });
      continue;
    }

    // 弱证据：同一候选累计到上限才抑制
    const fingerprint = buildFingerprint(env, {
      osRelease: true,
      appVersion: false,
      addonPath: mark.candidatePath,
    });
    const previousStrike = current.strikes.find((s) => s.key === key);
    const count = (previousStrike?.count ?? 0) + 1;
    const others = current.strikes.filter((s) => s.key !== key);
    if (count >= WEAK_STRIKE_LIMIT) {
      const suppression: Suppression = {
        scope: 'candidate',
        key,
        reason: 'crash',
        evidence: 'weak',
        since: now,
        fingerprint,
      };
      current = upsertSuppression({ ...current, strikes: others }, suppression);
      changes.push({ kind: 'suppressed', suppression });
    } else {
      current = {
        ...current,
        strikes: [...others, { key, count, lastAt: now, fingerprint }],
      };
      changes.push({ kind: 'strike', key, count });
    }
  }
  return { table: current, changes };
}

/** 对账产生的变化，写进应用日志的一行。 */
export function describeBreakerChange(change: BreakerChange): {
  level: 'info' | 'warning';
  message: string;
} {
  switch (change.kind) {
    case 'suppressed': {
      const { suppression: s } = change;
      const what =
        s.scope === 'family'
          ? 'all prebuilt x64 whisper addons'
          : `whisper candidate ${s.key}`;
      return {
        level: 'warning',
        message: `Crash breaker: ${what} suppressed (${s.evidence} evidence, ${s.reason})${s.detail ? `: ${s.detail}` : ''}`,
      };
    }
    case 'strike':
      return {
        level: 'info',
        message: `Crash breaker: ${change.key} was running when the previous run ended abnormally (${change.count} of ${WEAK_STRIKE_LIMIT} before it is suppressed)`,
      };
    case 'dropped':
      return {
        level: 'info',
        message: `Crash breaker: ${change.what} for ${change.key} cleared because the environment changed`,
      };
  }
}
