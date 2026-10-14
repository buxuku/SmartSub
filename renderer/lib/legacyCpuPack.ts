import type { CpuAdvisory } from '../../types/cpuAdvisory';

/** 旧 CPU（不支持 AVX2）兼容包的发布页：下载哪个文件、怎么导入，都写在这一页 */
export const LEGACY_CPU_PACK_URL =
  'https://github.com/buxuku/whisper.cpp/releases/tag/legacy-cpu';

/**
 * 这台电脑是否应该被指向兼容包。
 *
 * 兼容包只有 Windows / Linux 的 x64 版本，指令集基线是 SSE4.2 + AVX（没有 AVX2 / FMA / F16C / BMI）：
 * - 必须有“明确缺失”的指令集，探测不到（unknown）的一律不打扰；
 * - 缺的是 AVX 本身时，兼容包同样跑不了，不推荐；
 * - macOS、ARM 与转译环境没有对应的包。
 */
export function canUseLegacyCpuPack(advisory: CpuAdvisory): boolean {
  if (!advisory.applicable || advisory.translated) return false;
  if (advisory.platform !== 'win32' && advisory.platform !== 'linux') {
    return false;
  }
  return advisory.missing.length > 0 && !advisory.missing.includes('avx');
}
