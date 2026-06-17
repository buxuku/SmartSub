/** sherpa-onnx 原生库远端产物清单（引擎仓 sherpa-libs-latest 的 manifest.json）。 */
export interface RemoteSherpaLibManifest {
  /** 平台 key：darwin-arm64 / darwin-x64 / win-x64 / win-ia32 / linux-x64 / linux-arm64 */
  platform: string;
  /** sherpa-onnx-node 版本，如 1.13.2 */
  sherpaVersion: string;
  /** 库文件清单：sherpa-onnx.node + *.dylib/.so/.dll */
  files: string[];
  builtAt: string;
}

/** 本地 sherpa 原生库安装状态（供 UI / systemInfo 展示）。 */
export interface SherpaLibStatus {
  installed: boolean;
  version?: string;
  platform?: string;
  installedAt?: string;
}
