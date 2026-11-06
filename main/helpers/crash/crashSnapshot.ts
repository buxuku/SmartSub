/**
 * 诊断包 addon.json 里“崩溃熔断”的那一段：哪些后端被停用、为什么、
 * 上一次运行是怎么结束的。纯函数，不碰 electron，便于单测。
 *
 * 只挑选可序列化的、对排查有用的字段：转储摘要里有 BigInt 等不能直接 JSON 化的内容，
 * 整个塞进去会让 addon.json 整段收集失败。
 */
import type { PreviousRunAssessment } from './previousRun';
import type { BreakerSnapshot } from './nativeGuard';

export interface CrashSnapshot {
  crashBreaker: {
    enabled: boolean;
    suppressions: BreakerSnapshot['suppressions'];
    strikes: BreakerSnapshot['strikes'];
  };
  previousRun: {
    status: PreviousRunAssessment['status'];
    evidence: PreviousRunAssessment['evidence'];
    inFlight: PreviousRunAssessment['inFlight'];
    newDumps: Array<{
      name: string;
      mtimeMs: number;
      exception: string | null;
      faultModule: string | null;
      kind: string | null;
    }>;
  } | null;
}

export function buildCrashSnapshot(
  breaker: BreakerSnapshot,
  previous: PreviousRunAssessment | null,
): CrashSnapshot {
  return {
    crashBreaker: {
      enabled: breaker.enabled,
      suppressions: breaker.suppressions,
      strikes: breaker.strikes,
    },
    previousRun: previous && {
      status: previous.status,
      evidence: previous.evidence,
      inFlight: previous.inFlight,
      newDumps: previous.newDumps.map((dump) => ({
        name: dump.name,
        mtimeMs: dump.mtimeMs,
        exception: dump.summary?.exception?.name ?? null,
        faultModule: dump.summary?.faultModule?.name ?? null,
        kind: dump.classification?.kind ?? null,
      })),
    },
  };
}
