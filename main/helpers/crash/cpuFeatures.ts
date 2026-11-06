/**
 * CPU 指令集探测（只做预警，从不阻断）。
 *
 * 内置 whisper 的预编译 x64 加速包按 AVX / AVX2 / F16C / FMA / BMI2 编译；
 * 缺其中任何一项，加载或转写时就会以“非法指令”崩溃（QEMU 复现过，见崩溃防护的验证记录）。
 * 这里在崩溃之前给出提醒：
 *
 * - 三态：true 有、false 明确没有、null 探测不到。只有明确的 false 才会触发预警，
 *   null 一律当“不知道”，绝不当“没有”。
 * - Linux 读 /proc/cpuinfo；macOS Intel 读 sysctl hw.optional.*；
 *   Windows 只能经 PowerShell 的 IsProcessorFeaturePresent 查 AVX / AVX2（FMA、F16C、BMI2 没有对应常量）。
 * - x64 进程在 ARM 转译（Rosetta、Windows 的 x64 模拟）下运行时，探测值不可信，直接不判断。
 * - 所有外部访问经依赖注入（CpuProbeDeps），单测用假数据；任何一步失败都只是“不知道”，不会抛错。
 */
import {
  REQUIRED_X64_FEATURES,
  type CpuAdvisory,
  type CpuFeatureReport,
  type CpuFeatureValue,
  type RequiredCpuFeature,
} from '../../../types/cpuAdvisory';
import { parseProcCpuinfo } from './cpuInfo';

export { REQUIRED_X64_FEATURES };

/**
 * 外部命令（PowerShell 冷启动 + Add-Type 编译）的超时上限。
 * 真机 CI 上多数是 0.3 到 2.3 秒，但第一次跑遇到过一台 10 秒也没完成（之后三台都正常，原因没能复现，
 * 推断是该 VM 上 PowerShell 冷启动偶发很慢）。探测在后台跑，不挡启动和界面，所以放宽到 30 秒；
 * 超时也只是“不知道”，不会出预警。
 */
export const WINDOWS_PROBE_TIMEOUT_MS = 30_000;

/**
 * Windows 上 IsProcessorFeaturePresent 认识 AVX（39）、AVX2（40）要 Windows 10 2004（构建号 19041）及以上。
 * 更早的系统对不认识的常量返回 FALSE，那不能当成“CPU 没有”。
 */
export const WINDOWS_MIN_BUILD_FOR_AVX_PROBE = 19041;

const WINDOWS_FEATURE_IDS = { avx: 39, avx2: 40 } as const;

const MAC_OIDS: Record<RequiredCpuFeature, string> = {
  avx: 'hw.optional.avx1_0',
  avx2: 'hw.optional.avx2_0',
  fma: 'hw.optional.fma',
  f16c: 'hw.optional.f16c',
  bmi2: 'hw.optional.bmi2',
};

export type CpuFeatures = Record<RequiredCpuFeature, CpuFeatureValue>;

export interface CpuFeatureCacheEntry {
  /** CPU 型号与系统版本拼成的键，任何一个变了缓存就作废 */
  key: string;
  features: CpuFeatures;
  detectedAt: number;
}

export interface CpuProbeDeps {
  platform: NodeJS.Platform;
  arch: string;
  /** x64 进程是否在 ARM 转译下运行（Electron 的 app.runningUnderARM64Translation） */
  translated: boolean;
  /** os.release()；Windows 上形如 10.0.19045 */
  osRelease: string;
  cpuModel: string | null;
  /** 读文本文件；不存在或失败返回 null */
  readFile: (file: string) => Promise<string | null>;
  /** 读 sysctl 的值；oid 不存在或失败返回 null */
  sysctl: (key: string) => Promise<string | null>;
  /**
   * 跑外部命令取标准输出；失败、超时、非零退出返回 null，或抛出带原因的错误
   * （原因会写进探测报告的 note，方便从诊断包里看出是超时还是起不来）。
   */
  run: (
    file: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<string | null>;
  /** Windows 探测较慢，结果按 CPU 型号 + 系统版本缓存；不提供就不缓存 */
  cache?: {
    read: () => CpuFeatureCacheEntry | null;
    write: (entry: CpuFeatureCacheEntry) => void;
  };
  now: () => number;
  /** Windows 的 %SystemRoot%，用于定位 powershell.exe（避免被 PATH 里的同名程序劫持） */
  systemRoot?: string;
}

export function unknownFeatures(): CpuFeatures {
  return { avx: null, avx2: null, fma: null, f16c: null, bmi2: null };
}

/** Linux：从 /proc/cpuinfo 的 flags 得出结论；没读到 flags 不能当成“全都没有”。 */
export function featuresFromProcFlags(flags: string[]): CpuFeatures {
  if (flags.length === 0) return unknownFeatures();
  const set = new Set(flags);
  return {
    avx: set.has('avx'),
    avx2: set.has('avx2'),
    fma: set.has('fma'),
    f16c: set.has('f16c'),
    bmi2: set.has('bmi2'),
  };
}

/** sysctl 的布尔 oid：1 有、0 没有；oid 不存在或读不出来是 unknown，不是“没有”。 */
export function parseSysctlBool(value: string | null): CpuFeatureValue {
  const text = value?.trim();
  if (text === '1') return true;
  if (text === '0') return false;
  return null;
}

/** os.release()（10.0.19045）里的构建号；读不出来返回 null。 */
export function windowsBuildOf(release: string): number | null {
  const [major, , build] = release.split('.');
  if (Number(major) < 10) return null;
  const parsed = Number(build);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Windows 探测命令。故意不用 -EncodedCommand：那是恶意脚本的常见写法，容易被杀软盯上；
 * 明文脚本只有两行，也不需要编码来躲引号。
 */
export function buildWindowsProbeCommand(systemRoot = 'C:\\Windows'): {
  file: string;
  args: string[];
} {
  const script =
    `Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);' -Name Cpu -Namespace Smartsub; ` +
    `foreach ($id in ${WINDOWS_FEATURE_IDS.avx},${WINDOWS_FEATURE_IDS.avx2}) { "$id=" + [Smartsub.Cpu]::IsProcessorFeaturePresent($id) }`;
  return {
    file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}

/** 解析探测命令的输出：每行形如 `40=True`；其余内容（编译警告等）忽略。 */
export function parseWindowsProbeOutput(
  output: string | null,
): Partial<Record<number, boolean>> {
  const got: Partial<Record<number, boolean>> = {};
  for (const line of (output ?? '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)=(true|false)$/i);
    if (match) got[Number(match[1])] = match[2].toLowerCase() === 'true';
  }
  return got;
}

function isFeatureValue(value: unknown): value is CpuFeatureValue {
  return value === null || typeof value === 'boolean';
}

/** 读缓存文件内容；格式不对一律当没有缓存。 */
export function parseCpuCache(text: string): CpuFeatureCacheEntry | null {
  try {
    const data = JSON.parse(text);
    if (typeof data?.key !== 'string' || typeof data?.detectedAt !== 'number') {
      return null;
    }
    const features = unknownFeatures();
    for (const name of REQUIRED_X64_FEATURES) {
      const value = data.features?.[name];
      if (value !== undefined && !isFeatureValue(value)) return null;
      features[name] = value ?? null;
    }
    return { key: data.key, features, detectedAt: data.detectedAt };
  } catch {
    return null;
  }
}

function cacheKey(deps: CpuProbeDeps): string {
  return `${deps.cpuModel ?? ''}|${deps.osRelease}`;
}

/** 错误原因压成一行短文本，写进 note（报告会进诊断包）。 */
function failureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function attempt<T>(run: () => Promise<T> | T): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

async function detectLinux(deps: CpuProbeDeps): Promise<CpuFeatureReport> {
  const text = await attempt(() => deps.readFile('/proc/cpuinfo'));
  const flags = text ? parseProcCpuinfo(text).flags : [];
  const features = featuresFromProcFlags(flags);
  return {
    applicable: true,
    translated: false,
    source: 'proc-cpuinfo',
    cpuModel: deps.cpuModel,
    features,
    ...(flags.length === 0
      ? { note: '/proc/cpuinfo has no readable flags line' }
      : {}),
  };
}

async function detectMac(deps: CpuProbeDeps): Promise<CpuFeatureReport> {
  const features = unknownFeatures();
  await Promise.all(
    REQUIRED_X64_FEATURES.map(async (name) => {
      features[name] = parseSysctlBool(
        await attempt(() => deps.sysctl(MAC_OIDS[name])),
      );
    }),
  );
  const anyKnown = REQUIRED_X64_FEATURES.some(
    (name) => features[name] !== null,
  );
  return {
    applicable: true,
    translated: false,
    source: 'sysctl',
    cpuModel: deps.cpuModel,
    features,
    ...(anyKnown ? {} : { note: 'sysctl hw.optional.* is not readable' }),
  };
}

async function detectWindows(deps: CpuProbeDeps): Promise<CpuFeatureReport> {
  const base = {
    applicable: true,
    translated: false,
    cpuModel: deps.cpuModel,
  };
  const build = windowsBuildOf(deps.osRelease);
  if (build === null || build < WINDOWS_MIN_BUILD_FOR_AVX_PROBE) {
    return {
      ...base,
      source: 'unavailable',
      features: unknownFeatures(),
      note: `Windows build ${build ?? 'unknown'} is older than ${WINDOWS_MIN_BUILD_FOR_AVX_PROBE}; IsProcessorFeaturePresent cannot report AVX / AVX2 reliably`,
    };
  }

  const key = cacheKey(deps);
  const cached = deps.cache ? await attempt(() => deps.cache!.read()) : null;
  if (cached && cached.key === key) {
    return {
      ...base,
      source: 'win32-ipf',
      features: cached.features,
      fromCache: true,
    };
  }

  const { file, args } = buildWindowsProbeCommand(deps.systemRoot);
  const startedAt = deps.now();
  let output: string | null = null;
  let failure: string | null = null;
  try {
    output = await deps.run(file, args, WINDOWS_PROBE_TIMEOUT_MS);
  } catch (error) {
    failure = failureText(error);
  }
  const detectMs = deps.now() - startedAt;
  const parsed = parseWindowsProbeOutput(output);
  const features: CpuFeatures = {
    ...unknownFeatures(),
    avx: parsed[WINDOWS_FEATURE_IDS.avx] ?? null,
    avx2: parsed[WINDOWS_FEATURE_IDS.avx2] ?? null,
  };
  const known = features.avx !== null || features.avx2 !== null;

  if (known && deps.cache) {
    const entry: CpuFeatureCacheEntry = {
      key,
      features,
      detectedAt: deps.now(),
    };
    await attempt(() => deps.cache!.write(entry));
  }
  return {
    ...base,
    source: known ? 'win32-ipf' : 'unavailable',
    features,
    detectMs,
    note: known
      ? 'FMA, F16C and BMI2 have no IsProcessorFeaturePresent constant'
      : output === null
        ? `powershell probe failed${failure ? `: ${failure}` : ' or timed out'}`
        : 'powershell probe output could not be parsed',
  };
}

export async function detectCpuFeatures(
  deps: CpuProbeDeps,
): Promise<CpuFeatureReport> {
  if (deps.arch !== 'x64') {
    return {
      applicable: false,
      translated: false,
      source: 'not-applicable',
      cpuModel: deps.cpuModel,
      features: unknownFeatures(),
    };
  }
  if (deps.translated) {
    return {
      applicable: true,
      translated: true,
      source: 'translated',
      cpuModel: deps.cpuModel,
      features: unknownFeatures(),
      note: 'x64 process under ARM translation; the reported CPU features are not reliable',
    };
  }
  if (deps.platform === 'linux') return detectLinux(deps);
  if (deps.platform === 'darwin') return detectMac(deps);
  if (deps.platform === 'win32') return detectWindows(deps);
  return {
    applicable: true,
    translated: false,
    source: 'unavailable',
    cpuModel: deps.cpuModel,
    features: unknownFeatures(),
    note: `no probe for platform ${deps.platform}`,
  };
}

/** 给界面的结论：只有明确缺失才算缺失；转译环境与 arm64 不做缺失判断。 */
export function toAdvisory(
  report: CpuFeatureReport,
  platform: string,
): CpuAdvisory {
  const judged = report.applicable && !report.translated;
  const missing: RequiredCpuFeature[] = [];
  const unknown: RequiredCpuFeature[] = [];
  if (report.applicable) {
    for (const name of REQUIRED_X64_FEATURES) {
      const value = judged ? report.features[name] : null;
      if (value === false) missing.push(name);
      else if (value === null) unknown.push(name);
    }
  }
  return {
    applicable: report.applicable,
    translated: report.translated,
    platform,
    missing,
    unknown,
    source: report.source,
    cpuModel: report.cpuModel,
  };
}
