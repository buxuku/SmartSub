import path from 'path';
import fs from 'fs';
import { getExtraResourcesPath } from '../utils';

/**
 * sherpa-onnx 原生库的「内置」布局与平台解析。
 *
 * 原生库随安装包内置在 `extraResources/sherpa/native/<platformKey>/`（构建期由
 * `scripts/fetch-sherpa-native.mjs` 落地，electron-builder 的 `sherpa/` 块一并打包并签名），
 * 运行时直接从该目录 dlopen——不再下载到 userData，也无 staging/current/previous 概念。
 */

/** 内置 sherpa-onnx 原生库版本（随 App 固定发布；与 fetch-sherpa-native.mjs 一致）。 */
export const SHERPA_VERSION = '1.13.2';

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

/** 内置原生库目录：`extraResources/sherpa/native/<platformKey>/`。 */
export function getSherpaLibDir(): string {
  return path.join(
    getExtraResourcesPath(),
    'sherpa',
    'native',
    getSherpaPlatformKey(),
  );
}

export function getSherpaNativePath(): string {
  return path.join(getSherpaLibDir(), 'sherpa-onnx.node');
}

/** 已安装 = 内置目录下存在 sherpa-onnx.node（打包产物恒真；dev 下需先 `yarn sherpa:fetch`）。 */
export function isSherpaLibInstalled(): boolean {
  return fs.existsSync(getSherpaNativePath());
}
