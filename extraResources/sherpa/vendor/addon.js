'use strict';
// 自定义加载器：覆盖官方 addon.js 按 npm 平台子包解析的逻辑。
// 改为从 userData 下载目录用 process.dlopen 加载原生 sherpa-onnx.node。
// SHERPA_ONNX_LIB_DIR 由主进程在创建 worker / 自检时通过 env 注入；
// 同目录内的 .dylib/.so/.dll 依赖由 worker 注入的 PATH/LD_LIBRARY_PATH
// 及 macOS 的 @loader_path 重写（见 sherpaLibDownloader.resignMac）解析。
const path = require('path');

const libDir = process.env.SHERPA_ONNX_LIB_DIR;
if (!libDir) {
  throw new Error(
    'SHERPA_ONNX_LIB_DIR is not set; cannot locate sherpa-onnx native library',
  );
}

const nativePath = path.join(libDir, 'sherpa-onnx.node');
const mod = { exports: {} };
process.dlopen(mod, nativePath);
module.exports = mod.exports;
