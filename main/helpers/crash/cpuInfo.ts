/**
 * CPU 信息的纯解析（不依赖 electron，也不直接读系统）。
 *
 * - Linux：/proc/cpuinfo 的 `model name` 与 `flags`（ARM 为 `Features`）
 * - macOS Intel：sysctl 的 machdep.cpu.features / leaf7_features / extfeatures 是空格分隔的大写列表
 *
 * 诊断包原样带上这些标志，便于对照“缺指令集导致闪退”（如 #493）这类问题。
 */

export interface ProcCpuInfo {
  model: string | null;
  /** 全部小写，原样保留 */
  flags: string[];
}

/** 解析 /proc/cpuinfo：取第一个处理器块的型号与标志（各核标志在实践中一致）。 */
export function parseProcCpuinfo(text: string): ProcCpuInfo {
  let model: string | null = null;
  let flags: string[] | null = null;
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (model === null && key === 'model name' && value) model = value;
    if (flags === null && (key === 'flags' || key === 'features') && value) {
      flags = value.split(/\s+/).filter(Boolean);
    }
    if (model !== null && flags !== null) break;
  }
  return { model, flags: flags ?? [] };
}

/** 解析 sysctl 输出的特性列表（空格分隔）；拿不到返回空数组。 */
export function parseSysctlFeatureList(
  value: string | null | undefined,
): string[] {
  if (!value) return [];
  return value.trim().split(/\s+/).filter(Boolean);
}
