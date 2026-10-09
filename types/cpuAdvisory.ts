/**
 * CPU 指令集探测结果在主进程与渲染进程之间传递的类型。
 *
 * 内置 whisper 的预编译 x64 加速包按 AVX / AVX2 / F16C / FMA / BMI2 编译，
 * CPU 缺其中任何一项，加载或转写时都会以“非法指令”崩溃。探测只做预警，
 * 从不阻断：读不到就是 unknown，不等于“不支持”。
 */

export const REQUIRED_X64_FEATURES = [
  'avx',
  'avx2',
  'fma',
  'f16c',
  'bmi2',
] as const;

export type RequiredCpuFeature = (typeof REQUIRED_X64_FEATURES)[number];

/** true = 有；false = 明确没有；null = 探测不到（不代表没有） */
export type CpuFeatureValue = boolean | null;

export type CpuFeatureSource =
  /** Linux：/proc/cpuinfo flags */
  | 'proc-cpuinfo'
  /** macOS Intel：sysctl hw.optional.* */
  | 'sysctl'
  /** Windows：IsProcessorFeaturePresent（PowerShell） */
  | 'win32-ipf'
  /** x64 进程在 ARM 转译下运行：探测值不可信，不做判断 */
  | 'translated'
  /** arm64 等：没有 x86 指令集门槛 */
  | 'not-applicable'
  /** 平台不支持或探测失败 */
  | 'unavailable';

export interface CpuFeatureReport {
  /** x86 指令集门槛是否适用（arm64 不适用） */
  applicable: boolean;
  /** x64 进程是否在 ARM 转译（Rosetta、Windows 上的 x64 模拟）下运行 */
  translated: boolean;
  source: CpuFeatureSource;
  cpuModel: string | null;
  features: Record<RequiredCpuFeature, CpuFeatureValue>;
  /** 探测耗时（毫秒），仅外部命令探测有值 */
  detectMs?: number;
  /** 结果来自缓存（没有重新探测） */
  fromCache?: boolean;
  /** 为什么某些项是 unknown，给排查的人看 */
  note?: string;
}

/** 给界面用的结论：只有“明确缺失”才算缺失。 */
export interface CpuAdvisory {
  applicable: boolean;
  translated: boolean;
  platform: string;
  /** 明确没有的指令集；空 = 没有确凿的缺失（可能全部具备，也可能探测不到） */
  missing: RequiredCpuFeature[];
  /** 探测不到的指令集 */
  unknown: RequiredCpuFeature[];
  source: CpuFeatureSource;
  cpuModel: string | null;
}
