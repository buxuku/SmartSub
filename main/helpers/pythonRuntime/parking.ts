import type { PyEngineId, PyEngineVariant } from '../../../types/engine';

/**
 * 运行时驻留（parked runtime）纯决策逻辑。
 *
 * 背景：cpu / cuda 变体安装在同一 current 目录（userData/py-engines/<engineId>），
 * 切换变体时旧运行时若直接删除，切回就得整包重新下载（CPU ~210MB / GPU ~1.4GB）。
 * 方案：切换时把旧运行时改名驻留到 .parked/ 槽位，切回时目录互换即可秒级完成。
 *
 * 不变式：任一引擎至多存在一个驻留槽（恒为「当前已装变体的另一侧」）——
 * 安装变体 X 成功后总会清掉陈旧的 parked[X]，而驻留只发生在 prev ≠ X 时。
 *
 * 本模块不依赖 electron/fs，便于单元测试；目录拼接见 paths.ts。
 */

/** 驻留槽目录名（相对 .parked/ 根）：<engineId>-<variant>，如 faster-whisper-cpu */
export function getParkedSlotName(
  engineId: PyEngineId,
  variant: PyEngineVariant,
): string {
  return `${engineId}-${variant}`;
}

/**
 * 安装成功后旧运行时备份的处置：
 * - 变体切换（prev ≠ 新装）且旧运行时完好 → 驻留，供即时切回；
 * - 同变体升级/修复，或旧运行时已破损 → 删除（驻留无意义）。
 */
export function planPreviousRuntimeDisposal(opts: {
  previousVariant: PyEngineVariant;
  installedVariant: PyEngineVariant;
  previousIntact: boolean;
}): 'park' | 'discard' {
  if (!opts.previousIntact) return 'discard';
  return opts.previousVariant === opts.installedVariant ? 'discard' : 'park';
}

/**
 * 是否满足「免下载即时切换」条件：目标变体有完好驻留副本，且目标 ≠ 当前已装变体
 * （同变体的下载请求是修复/升级语义，必须走真实下载）。
 * installedVariant 传 null 表示当前无完好运行时（未安装/破损）——此时若驻留副本
 * 完好同样允许直接启用，省去一次全量下载。
 */
export function canFastSwitchVariant(opts: {
  targetVariant: PyEngineVariant;
  installedVariant: PyEngineVariant | null;
  parkedTargetIntact: boolean;
}): boolean {
  return (
    opts.parkedTargetIntact && opts.installedVariant !== opts.targetVariant
  );
}
