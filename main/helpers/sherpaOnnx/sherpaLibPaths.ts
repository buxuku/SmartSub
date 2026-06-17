import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { RemoteSherpaLibManifest } from '../../../types/sherpa';

/**
 * sherpa-onnx 原生库的 userData 布局与平台解析。
 *
 * 库不随 asar 打包，按需下载到 userData/sherpa-onnx/current（避免 asar 内 .node 无法 dlopen）。
 * 升级走 staging→current 原子替换，旧版备份到 previous 以便回滚。
 */

/** 当前平台 key，与引擎仓产物命名一致（sherpa-onnx-<platformKey>）。 */
export function getSherpaPlatformKey(): string {
  const arch = process.arch === 'ia32' ? 'ia32' : process.arch; // x64 / arm64 / ia32
  if (process.platform === 'win32') {
    // Windows 仅发布 x64 / ia32；arm64 主机走 x64 仿真。
    return `win-${arch === 'arm64' ? 'x64' : arch}`;
  }
  if (process.platform === 'darwin') return `darwin-${arch}`;
  return `linux-${arch}`;
}

export function getSherpaRootDir(): string {
  const root = path.join(app.getPath('userData'), 'sherpa-onnx');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

export function getSherpaLibDir(): string {
  return path.join(getSherpaRootDir(), 'current');
}

export function getSherpaStagingDir(): string {
  return path.join(getSherpaRootDir(), 'staging');
}

export function getSherpaPreviousDir(): string {
  return path.join(getSherpaRootDir(), 'previous');
}

export function getSherpaNativePath(): string {
  return path.join(getSherpaLibDir(), 'sherpa-onnx.node');
}

export function getSherpaManifestPath(): string {
  return path.join(getSherpaLibDir(), 'manifest.json');
}

/** 已安装 = current 下存在 sherpa-onnx.node。 */
export function isSherpaLibInstalled(): boolean {
  return fs.existsSync(getSherpaNativePath());
}

export function readSherpaManifest(): RemoteSherpaLibManifest | null {
  try {
    const p = getSherpaManifestPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as RemoteSherpaLibManifest;
  } catch {
    return null;
  }
}
