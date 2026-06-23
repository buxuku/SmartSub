# sherpa vendor

封装 JS 复制自 npm `sherpa-onnx-node@1.13.2`（Apache-2.0）。

- `vendor/addon.js` 已替换为自定义加载器：从环境变量 `SHERPA_ONNX_LIB_DIR`
  用 `process.dlopen` 加载 `sherpa-onnx.node`（其余 `vendor/*.js` 原样保留，
  它们都经 `require('./addon.js')` 取原生模块）。
- `vendor/addon-static-import.js` 在自定义加载器下不再被引用（保留以便升级对照）。

原生库**不在此处**，按需下载到 `userData/sherpa-onnx/current/`
（见 `main/helpers/sherpaOnnx/sherpaLibDownloader.ts`，产物由引擎仓
`smartsub-py-engine` 的 `sherpa-libs` workflow 发布）。

`worker/sherpa-worker.js` 是转写 worker 入口（worker_threads，纯 JS，不经 webpack）。

升级 sherpa 版本：重新 `npm pack sherpa-onnx-node@<ver>` 覆盖 `vendor/` 内除
`addon.js` 外的文件，并同步更新引擎仓 `pack_sherpa_libs.mjs` / 下载器中的版本号。
