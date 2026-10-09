/**
 * 诊断包里的系统与 CPU 信息。
 *
 * 数据来源经依赖注入（SystemInfoDeps），单测用假数据；默认实现读 os / 文件 / sysctl。
 * 任何一项读不到都只是缺这一项，不影响其它项，更不会抛错。
 *
 * 刻意不包含：主机名、用户名、完整环境变量（只取下面白名单里的几个，不含凭据）。
 */
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { parseProcCpuinfo, parseSysctlFeatureList } from './cpuInfo';

/** 只读这些环境变量：都不含凭据，且对判断平台 / 区域 / GPU 可见性有帮助。 */
const ENV_WHITELIST = [
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'NUMBER_OF_PROCESSORS',
  'LANG',
  'LC_ALL',
  'XDG_SESSION_TYPE',
  'CUDA_VISIBLE_DEVICES',
  'GGML_NO_BACKTRACE',
  'SMARTSUB_DISABLE_CRASH_REPORTER',
] as const;

const MAC_SYSCTL_KEYS = {
  brand: 'machdep.cpu.brand_string',
  features: 'machdep.cpu.features',
  leaf7: 'machdep.cpu.leaf7_features',
  ext: 'machdep.cpu.extfeatures',
  translated: 'sysctl.proc_translated',
  arm64: 'hw.optional.arm64',
  model: 'hw.model',
} as const;

export interface SystemInfoDeps {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  osVersion: string;
  osType: string;
  machine: string;
  cpus: Array<{ model: string }>;
  totalMem: number;
  freeMem: number;
  env: NodeJS.ProcessEnv;
  /** 读文本文件；不存在或失败返回 null */
  readFile: (file: string) => Promise<string | null>;
  /** 读 macOS sysctl 的值；不存在或失败返回 null */
  sysctl: (key: string) => Promise<string | null>;
}

export interface SystemInfo {
  os: {
    platform: string;
    arch: string;
    release: string;
    version: string;
    type: string;
    machine: string;
    /** AppImage / Flatpak / Snap 里的运行环境会影响 prlimit 等外部命令是否可用 */
    packaging: 'appimage' | 'flatpak' | 'snap' | 'none';
  };
  cpu: {
    model: string | null;
    logicalCores: number;
    /** Linux：/proc/cpuinfo 的 flags（小写） */
    flags?: string[];
    /** macOS Intel：sysctl machdep.cpu.*（大写） */
    macFeatures?: string[];
    macLeaf7Features?: string[];
    macExtFeatures?: string[];
    /** macOS：x64 进程是否在 Rosetta 下运行（sysctl.proc_translated） */
    translatedByRosetta?: boolean | null;
    macModel?: string | null;
  };
  memory: { totalMB: number; freeMB: number };
  env: Record<string, string>;
  /** 读取失败的项，便于看出“为什么这里是空的” */
  unavailable: string[];
}

function toMB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function detectPackaging(
  env: NodeJS.ProcessEnv,
): SystemInfo['os']['packaging'] {
  if (env.APPIMAGE) return 'appimage';
  if (env.FLATPAK_ID) return 'flatpak';
  if (env.SNAP) return 'snap';
  return 'none';
}

export async function gatherSystemInfo(
  deps: SystemInfoDeps = createDefaultSystemDeps(),
): Promise<SystemInfo> {
  const unavailable: string[] = [];
  const cpuModel = deps.cpus[0]?.model?.trim() || null;
  const info: SystemInfo = {
    os: {
      platform: deps.platform,
      arch: deps.arch,
      release: deps.release,
      version: deps.osVersion,
      type: deps.osType,
      machine: deps.machine,
      packaging: detectPackaging(deps.env),
    },
    cpu: { model: cpuModel, logicalCores: deps.cpus.length },
    memory: { totalMB: toMB(deps.totalMem), freeMB: toMB(deps.freeMem) },
    env: {},
    unavailable,
  };

  for (const name of ENV_WHITELIST) {
    const value = deps.env[name];
    if (value) info.env[name] = value;
  }

  if (deps.platform === 'linux') {
    try {
      const text = await deps.readFile('/proc/cpuinfo');
      if (text === null) {
        unavailable.push('cpu.flags');
      } else {
        const parsed = parseProcCpuinfo(text);
        info.cpu.flags = parsed.flags;
        if (!info.cpu.model && parsed.model) info.cpu.model = parsed.model;
        if (parsed.flags.length === 0) unavailable.push('cpu.flags');
      }
    } catch {
      unavailable.push('cpu.flags');
    }
  }

  if (deps.platform === 'darwin') {
    const read = async (key: string): Promise<string | null> => {
      try {
        return await deps.sysctl(key);
      } catch {
        return null;
      }
    };
    const [brand, features, leaf7, ext, translated, model] = await Promise.all([
      read(MAC_SYSCTL_KEYS.brand),
      read(MAC_SYSCTL_KEYS.features),
      read(MAC_SYSCTL_KEYS.leaf7),
      read(MAC_SYSCTL_KEYS.ext),
      read(MAC_SYSCTL_KEYS.translated),
      read(MAC_SYSCTL_KEYS.model),
    ]);
    if (!info.cpu.model && brand) info.cpu.model = brand.trim();
    // Apple Silicon 没有 machdep.cpu.features，这几项为空是正常的
    const featureList = parseSysctlFeatureList(features);
    if (featureList.length) info.cpu.macFeatures = featureList;
    const leaf7List = parseSysctlFeatureList(leaf7);
    if (leaf7List.length) info.cpu.macLeaf7Features = leaf7List;
    const extList = parseSysctlFeatureList(ext);
    if (extList.length) info.cpu.macExtFeatures = extList;
    info.cpu.translatedByRosetta =
      translated === null ? null : translated.trim() === '1';
    info.cpu.macModel = model?.trim() || null;
  }

  return info;
}

function execSysctl(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/sysctl',
      ['-n', key],
      { timeout: 2000, windowsHide: true },
      (error, stdout) => {
        resolve(error ? null : String(stdout).trim() || null);
      },
    );
  });
}

export function createDefaultSystemDeps(): SystemInfoDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    osVersion: os.version(),
    osType: os.type(),
    machine: os.machine(),
    cpus: os.cpus() ?? [],
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    env: process.env,
    readFile: async (file) => {
      try {
        return await fs.promises.readFile(file, 'utf8');
      } catch {
        return null;
      }
    },
    sysctl: execSysctl,
  };
}
