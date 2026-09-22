import fs from 'fs';
import path from 'path';
import type { PyEngineManifest, PyEngineVariant } from '../../../types/engine';
import { isProtocolSupported } from './protocolSupport';

/**
 * 如果解压/复制后存在单层或多层包装目录（例如 faster-whisper/python.exe，或 runtime/bin/python3），
 * 自动展平到 stagingDir 根目录（最多检测 3 层嵌套）。
 */
export function normalizeStagingLayout(stagingDir: string): void {
  for (let i = 0; i < 3; i++) {
    if (
      fs.existsSync(path.join(stagingDir, 'main.py')) &&
      fs.existsSync(path.join(stagingDir, 'site-packages'))
    ) {
      break;
    }
    const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
    const subdirs = entries.filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__'),
    );
    if (subdirs.length === 1) {
      const singleSubdir = path.join(stagingDir, subdirs[0].name);
      const innerEntries = fs.readdirSync(singleSubdir);
      for (const entry of innerEntries) {
        fs.renameSync(
          path.join(singleSubdir, entry),
          path.join(stagingDir, entry),
        );
      }
      fs.rmdirSync(singleSubdir);
    } else {
      break;
    }
  }
}

/** 从任意运行时目录读 manifest.json（纯函数，无 Electron 依赖）。 */
export function readEngineManifestFromDir(
  runtimeDir: string,
): PyEngineManifest | null {
  const p = path.join(runtimeDir, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as PyEngineManifest;
  } catch {
    return null;
  }
}

export const readManifestFromDir = readEngineManifestFromDir;

/**
 * 启发式探测二进制可执行文件的目标 CPU 架构（支持 Mach-O 64位/通用、ELF 64位、PE 64位）。
 */
export function detectBinaryArch(
  binaryPath: string,
): 'x64' | 'arm64' | 'universal' | 'unknown' {
  if (!fs.existsSync(binaryPath)) return 'unknown';
  try {
    const fd = fs.openSync(binaryPath, 'r');
    const buf = Buffer.alloc(64);
    const bytesRead = fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    if (bytesRead < 16) return 'unknown';

    // 1. Mach-O (macOS)
    // 64-bit Little Endian (common for x86_64 / arm64 macOS)
    if (
      buf[0] === 0xcf &&
      buf[1] === 0xfa &&
      buf[2] === 0xed &&
      buf[3] === 0xfe
    ) {
      const cpu = buf.readUInt32LE(4);
      if (cpu === 0x01000007) return 'x64';
      if (cpu === 0x0100000c) return 'arm64';
      return 'unknown';
    }
    // Universal binary / FAT Mach-O
    if (
      (buf[0] === 0xca &&
        buf[1] === 0xfe &&
        buf[2] === 0xba &&
        buf[3] === 0xbe) ||
      (buf[0] === 0xbe && buf[1] === 0xba && buf[2] === 0xfe && buf[3] === 0xca)
    ) {
      return 'universal';
    }

    // 2. ELF (Linux)
    if (
      buf[0] === 0x7f &&
      buf[1] === 0x45 &&
      buf[2] === 0x4c &&
      buf[3] === 0x46
    ) {
      if (bytesRead >= 20) {
        const machine = buf.readUInt16LE(18);
        if (machine === 0x3e) return 'x64';
        if (machine === 0xb7) return 'arm64';
      }
      return 'unknown';
    }

    // 3. PE (Windows)
    if (buf[0] === 0x4d && buf[1] === 0x5a) {
      if (bytesRead >= 64) {
        const peOffset = buf.readUInt32LE(0x3c);
        const fd2 = fs.openSync(binaryPath, 'r');
        const peBuf = Buffer.alloc(8);
        fs.readSync(fd2, peBuf, 0, 8, peOffset);
        fs.closeSync(fd2);
        if (
          peBuf[0] === 0x50 &&
          peBuf[1] === 0x45 &&
          peBuf[2] === 0 &&
          peBuf[3] === 0
        ) {
          const machine = peBuf.readUInt16LE(4);
          if (machine === 0x8664) return 'x64';
          if (machine === 0xaa64) return 'arm64';
        }
      }
      return 'unknown';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 从包内 _version.py 解析动态版本信息（无 manifest.json 时的动态兜底）。 */
export function extractEmbeddedPythonVersion(stagingDir: string): {
  engineVersion?: string;
  protocolVersion?: number;
} {
  const versionFile = path.join(stagingDir, '_version.py');
  if (!fs.existsSync(versionFile)) return {};
  try {
    const content = fs.readFileSync(versionFile, 'utf8');
    const engineMatch = content.match(/ENGINE_VERSION\s*=\s*["']([^"']+)["']/);
    const protocolMatch = content.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
    return {
      engineVersion: engineMatch?.[1],
      protocolVersion: protocolMatch ? Number(protocolMatch[1]) : undefined,
    };
  } catch {
    return {};
  }
}

export interface CompatibilityCheckResult {
  ok: boolean;
  variant: PyEngineVariant;
  platform: string;
  pkgManifest: PyEngineManifest | null;
  error?: string;
}

/**
 * 校验解压至 stagingDir 的运行时与目标平台和当前系统的兼容性。
 *
 * 检查项：
 * 1. 包内 manifest.platform 与当前系统平台（getPyEngineArtifactSuffix）比对
 * 2. 操作系统解释器格式防呆（win32 需 python.exe；unix 需 bin/python3）
 * 3. 解释器架构防呆（arm64 / x64 比对，防止 macOS/Linux 跨架构混用）
 * 4. 完好性检查（解释器、main.py、site-packages 必须齐全）
 * 5. 变体识别（manifest.variant > site-packages/nvidia 推断 > cpu 兜底）
 * 6. 变体可用性检查（如 macOS 不支持 CUDA GPU 运行时）
 * 7. 协议版本区间校验（老 app 阻止安装未来不兼容协议引擎）
 */
export function verifyRuntimeCompatibility(input: {
  stagingDir: string;
  currentPlatform: string;
  currentOs?: string;
  currentArch?: string;
}): CompatibilityCheckResult {
  const { stagingDir, currentPlatform } = input;
  const currentOs = input.currentOs ?? process.platform;
  const currentArch = input.currentArch ?? process.arch;
  const pkgManifest = readEngineManifestFromDir(stagingDir);

  // 1. 显式 platform 校验
  if (pkgManifest?.platform && pkgManifest.platform !== currentPlatform) {
    return {
      ok: false,
      variant: 'cpu',
      platform: currentPlatform,
      pkgManifest,
      error: `所选运行时与当前系统不匹配（包平台：${pkgManifest.platform}，当前系统：${currentPlatform}）`,
    };
  }

  // 2. 解释器格式防呆
  const hasWinExe = fs.existsSync(path.join(stagingDir, 'python.exe'));
  const hasUnixBin = fs.existsSync(path.join(stagingDir, 'bin', 'python3'));
  if (currentOs === 'win32' && !hasWinExe && hasUnixBin) {
    return {
      ok: false,
      variant: 'cpu',
      platform: currentPlatform,
      pkgManifest,
      error: '所选运行时为 macOS/Linux 版本，无法在 Windows 系统上运行',
    };
  }
  if (currentOs !== 'win32' && hasWinExe && !hasUnixBin) {
    return {
      ok: false,
      variant: 'cpu',
      platform: currentPlatform,
      pkgManifest,
      error: '所选运行时为 Windows 版本，无法在当前系统上运行',
    };
  }

  // 3. 解释器架构防呆（检查 Mach-O / ELF / PE 的目标架构）
  const binaryPath =
    currentOs === 'win32'
      ? path.join(stagingDir, 'python.exe')
      : path.join(stagingDir, 'bin', 'python3');
  if (fs.existsSync(binaryPath)) {
    const detectedArch = detectBinaryArch(binaryPath);
    if (
      detectedArch !== 'unknown' &&
      detectedArch !== 'universal' &&
      detectedArch !== currentArch
    ) {
      return {
        ok: false,
        variant: 'cpu',
        platform: currentPlatform,
        pkgManifest,
        error: `所选运行时架构与当前系统不匹配（包架构：${detectedArch}，当前系统：${currentArch}）`,
      };
    }
  }

  // 4. 核心文件完好性
  const interpreterIntact = currentOs === 'win32' ? hasWinExe : hasUnixBin;
  const mainPyExists = fs.existsSync(path.join(stagingDir, 'main.py'));
  const sitePackagesExists = fs.existsSync(
    path.join(stagingDir, 'site-packages'),
  );

  if (!interpreterIntact || !mainPyExists || !sitePackagesExists) {
    return {
      ok: false,
      variant: 'cpu',
      platform: currentPlatform,
      pkgManifest,
      error: '无效的运行时包：缺少 Python 解释器、main.py 或 site-packages',
    };
  }

  // 5. 变体推断
  let variant: PyEngineVariant;
  if (
    pkgManifest?.variant &&
    (pkgManifest.variant === 'cuda' || pkgManifest.variant === 'cpu')
  ) {
    variant = pkgManifest.variant;
  } else if (fs.existsSync(path.join(stagingDir, 'site-packages', 'nvidia'))) {
    variant = 'cuda';
  } else {
    variant = 'cpu';
  }

  // 6. 变体平台支持（macOS 不支持 CUDA）
  const cudaSupported = currentOs === 'win32' || currentOs === 'linux';
  if (variant === 'cuda' && !cudaSupported) {
    return {
      ok: false,
      variant,
      platform: currentPlatform,
      pkgManifest,
      error: `当前操作系统（${currentOs}）不支持 CUDA GPU 运行时，请使用 CPU 运行时`,
    };
  }

  // 7. 协议版本区间校验（优先 pkgManifest，其次 stagingDir/_version.py）
  const effectiveProtocol =
    pkgManifest?.protocolVersion ??
    extractEmbeddedPythonVersion(stagingDir).protocolVersion;
  if (
    effectiveProtocol !== undefined &&
    !isProtocolSupported(effectiveProtocol)
  ) {
    return {
      ok: false,
      variant,
      platform: currentPlatform,
      pkgManifest,
      error: `运行时协议版本 (v${effectiveProtocol}) 与当前客户端不兼容，请先升级客户端`,
    };
  }

  return {
    ok: true,
    variant,
    platform: currentPlatform,
    pkgManifest,
  };
}

/** 组装导入后的最终 PyEngineManifest */
export function buildImportedManifest(input: {
  pkgManifest: PyEngineManifest | null;
  currentPlatform: string;
  variant: PyEngineVariant;
  engineId?: string;
  sha256?: string;
  installedAt?: string;
  stagingDir?: string;
}): PyEngineManifest {
  const { pkgManifest, currentPlatform, variant, stagingDir } = input;
  const embeddedMeta = stagingDir
    ? extractEmbeddedPythonVersion(stagingDir)
    : {};
  const engineVersion =
    pkgManifest?.engineVersion ||
    pkgManifest?.version ||
    embeddedMeta.engineVersion ||
    'latest';
  const protocolVersion =
    pkgManifest?.protocolVersion || embeddedMeta.protocolVersion || 1;

  return {
    version: engineVersion,
    platform: currentPlatform,
    sha256: input.sha256 ?? pkgManifest?.sha256 ?? '',
    installedAt: input.installedAt ?? new Date().toISOString(),
    engineVersion,
    protocolVersion,
    builtAt: pkgManifest?.builtAt || new Date().toISOString(),
    gitSha: pkgManifest?.gitSha,
    engineId: input.engineId || 'faster-whisper',
    pythonAbi: pkgManifest?.pythonAbi || 'cp312',
    variant,
  };
}
