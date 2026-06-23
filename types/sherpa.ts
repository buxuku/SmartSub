/** 本地 sherpa 原生库安装状态（供 UI / systemInfo 展示）。 */
export interface SherpaLibStatus {
  installed: boolean;
  version?: string;
  platform?: string;
  installedAt?: string;
}
