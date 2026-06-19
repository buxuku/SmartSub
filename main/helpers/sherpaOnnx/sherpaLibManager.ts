import {
  isSherpaLibInstalled,
  getSherpaPlatformKey,
  SHERPA_VERSION,
} from './sherpaLibPaths';
import type { SherpaLibStatus } from '../../../types/sherpa';

/**
 * sherpa 原生库随安装包内置，状态即「内置文件是否存在」+ 内置版本常量。
 * 运行时下载方案（staging→current 原子替换 / rollback / remove）已退役，故不再提供
 * promote/rollback/remove——内置库随 App 升级整体替换。
 */
export function getSherpaLibStatus(): SherpaLibStatus {
  const installed = isSherpaLibInstalled();
  return {
    installed,
    version: installed ? SHERPA_VERSION : undefined,
    platform: installed ? getSherpaPlatformKey() : undefined,
  };
}
