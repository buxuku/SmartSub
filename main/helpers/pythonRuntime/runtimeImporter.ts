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
export function readManifestFromDir(
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
 * 3. 完好性检查（解释器、main.py、site-packages 必须齐全）
 * 4. 变体识别（manifest.variant > site-packages/nvidia 推断 > cpu 兜底）
 * 5. 变体可用性检查（如 macOS 不支持 CUDA GPU 运行时）
 * 6. 协议版本区间校验（老 app 阻止安装未来不兼容协议引擎）
 */
export function verifyRuntimeCompatibility(input: {
  stagingDir: string;
  currentPlatform: string;
  currentOs?: string;
}): CompatibilityCheckResult {
  const { stagingDir, currentPlatform } = input;
  const currentOs = input.currentOs ?? process.platform;
  const pkgManifest = readManifestFromDir(stagingDir);

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

  // 3. 核心文件完好性
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

  // 4. 变体推断
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

  // 5. 变体平台支持（macOS 不支持 CUDA）
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

  // 6. 协议版本区间校验
  if (
    pkgManifest?.protocolVersion &&
    !isProtocolSupported(pkgManifest.protocolVersion)
  ) {
    return {
      ok: false,
      variant,
      platform: currentPlatform,
      pkgManifest,
      error: `运行时协议版本 (v${pkgManifest.protocolVersion}) 与当前客户端不兼容，请先升级客户端`,
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
}): PyEngineManifest {
  const { pkgManifest, currentPlatform, variant } = input;
  return {
    version: pkgManifest?.engineVersion || pkgManifest?.version || 'latest',
    platform: currentPlatform,
    sha256: input.sha256 ?? pkgManifest?.sha256 ?? '',
    installedAt: input.installedAt ?? new Date().toISOString(),
    engineVersion: pkgManifest?.engineVersion || '0.4.0',
    protocolVersion: pkgManifest?.protocolVersion || 1,
    builtAt: pkgManifest?.builtAt || new Date().toISOString(),
    gitSha: pkgManifest?.gitSha,
    engineId: input.engineId || 'faster-whisper',
    pythonAbi: pkgManifest?.pythonAbi || 'cp312',
    variant,
  };
}
