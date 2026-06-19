## 1. 前置依赖：上游 py-engine 仓改造（D5，本仓外但纳入计划）

- [x] 1.1 新增 `build_runtime_package.py`：PBS 基座（`uv python install 3.12.10`，baseline `install_only`）+ `uv pip install --only-binary=:all: -r requirements-faster-whisper.txt` 的 site-packages + `main.py`/`_version.py`/`engines/` 合到单 OUT；清 `__pycache__`；macOS ad-hoc 重签全部 `.dylib/.so`；包模式 smoke（OUT 解释器 + `PYTHONPATH=OUT/site-packages`，`find_spec('faster_whisper')`）〔已写 + `py_compile` 通过；全量构建在 CI 验证〕
- [x] 1.2 `release.yml`：`(os,arch)` 矩阵（macos-arm64 / macos-x64 / windows-x64 / linux-x64）在匹配 runner 产出 `smartsub-faster-whisper-runtime-<suffix>.tar.gz`（顶层即内嵌解释器 + site-packages + main.py）；发布滚动 `latest`〔单 `build_runtime` job，已去 funasr/base 维度；CI 验证〕
- [x] 1.3 `manifest.json`：暴露运行时 `artifact` / `sha256` / `size` / `pythonVersion` / `protocolVersion` / `engineVersion`；`checksums.sha256` 收录运行时包〔`runtime.artifacts[suffix]` + 顶层版本字段〕
- [x] 1.4 退役 `build_base_package.py` / `build_engine_package.py` 与 `smartsub-base-*` / `smartsub-<engineId>-*` 产物及 `manifest.basePackage` / `enginePackages`；**保留** `sherpa-libs-latest`（供 App 构建期内置 sherpa，见 §2）〔删两脚本 + `requirements-funasr.txt`；manifest 去 base/enginePackages 桶〕
- [x] 1.5 更新上游 README 为「单运行时包」分发说明（去 PyInstaller / 双层残留描述）
- [x] 1.6 确认 `sherpa-libs-latest` 的 `smartsub-sherpa-onnx-<platformKey>-<ver>.tar.gz` 可被 App 构建脚本直接消费（含 `.node` + onnxruntime 依赖）〔App 今天已下载消费：tag `sherpa-libs-latest`、`SHERPA_VERSION=1.13.2`、`getSherpaPlatformKey()`；tar.gz 解出 `sherpa-onnx.node` + 依赖〕

## 2. 构建：内置 sherpa 原生库

- [x] 2.1 新增 `scripts/fetch-sherpa-native.mjs`：按 host 平台拉取 sherpa 原生库到 `extraResources/sherpa/native/<platformKey>/`；macOS 执行 `@rpath→@loader_path` 改写（迁移 `sherpaLibDownloader.resignMac` 逻辑）〔https 下载 + tar 解包 + 校验 + macOS install_name 改写/ad-hoc 重签〕
- [x] 2.2 `package.json` 增 `base:fetch` 同级脚本 `sherpa:fetch`（或合并到统一 prebuild）〔`base:fetch`→`sherpa:fetch`；CI `release.yml` 同步改为 `yarn sherpa:fetch`〕
- [x] 2.3 `electron-builder.yml`：移除 mac/win/linux 三处 `./extraResources/py-base/` extraResources 块〔已删 3 处；`sherpa/` 块 `**/*` 已含新 `native/` 子目录〕
- [x] 2.4 校验 macOS 签名/公证覆盖 `extraResources/sherpa/native/**` 的 `.node`/`.dylib`（必要时加 `asarUnpack`/签名条目）〔native mach-o 随 `sherpa/` 进 Resources、与现有 `addons/` 同路径深签；`@rpath` 改写在 `sherpa:fetch`（签名前）；最终 mac 构建验证见 8.5〕
- [x] 2.5 删除/改造 `scripts/fetch-python-base.mjs`（不再产出 `extraResources/py-base`）〔已删除〕

## 3. 主进程：sherpa 运行库解析为内置

- [ ] 3.1 `sherpaOnnx/sherpaLibPaths.ts`：`getSherpaLibDir()` → `getExtraResourcesPath()/sherpa/native/<getSherpaPlatformKey()>`；`isSherpaLibInstalled()` → 内置文件存在性
- [ ] 3.2 退役 `sherpaLibDownloader.ts`（下载/校验/多源回退/运行时 `resignMac`/`assertLoadable`）
- [ ] 3.3 `sherpaLibManager.ts`：移除 staging/promote/rollback/remove；`getSherpaLibStatus()` 改读内置 manifest（或返回内置版本常量）
- [ ] 3.4 移除 sherpa 运行库下载/升级/卸载/进度的 IPC handlers 与事件
- [ ] 3.5 worker 加载路径确认仍指向内置 `sherpa-onnx.node`（`extraResources/sherpa/worker` + `vendor` 不变）

## 4. 主进程：faster-whisper 单运行时包

- [ ] 4.1 `pythonRuntime/paths.ts`：定义单运行时目录与 `getFasterWhisperRuntimeArtifactName()`/`getRuntimeDownloadUrl()`；退役 `getBuiltinPyBaseDir`/`resolvePyBaseDir`/`getBaseArtifactName`/`getBaseDownloadUrl`/`enginePackages` 相关
- [ ] 4.2 `pythonRuntime/downloader.ts`：下载单包并解包到 `userData/py-engines/faster-whisper`（含内嵌解释器）；写精简 manifest
- [ ] 4.3 `pythonRuntime/manager.ts`：从运行时内嵌解释器 spawn（`PYTHONHOME`/`PYTHONPATH` 指向运行时内部），删除对内置/外部基座的引用
- [ ] 4.4 `types/engine.ts`：精简 `PyEngineManifest`；移除 `RemoteBasePackage`/`RemoteEnginePackage`/`enginePackages`/`PyBase*` 等多引擎/分层类型（保留单运行时所需）
- [ ] 4.5 `fasterWhisperEngine.ts#isAvailable`：仅判运行时已安装；删除 `isPyBaseReady()` 的 error 分支与 `isEnginePackageInstalled` 旧判定
- [ ] 4.6 `pythonRuntime/autoUpdateCheck.ts`：基座升级检查改为单运行时升级检查（或移除基座维度）

## 5. 渲染层

- [ ] 5.1 `SherpaRuntimePanel.tsx`：移除下载/升级/卸载/进度 UI 与确认弹窗；sherpa 标注「已内置」，引擎就绪仅看 ASR 模型
- [ ] 5.2 `useSherpaRuntime.ts`：精简为状态展示（installed 恒真 + 版本），去掉 download/checkUpdate/uninstall
- [ ] 5.3 `EngineModelTab.tsx`：去掉 sherpa 运行库下载态相关分支与 `binarySource` 对 sherpa 的传递（faster-whisper 仍保留下载源选择）
- [ ] 5.4 `FasterWhisperPanel.tsx`/`EngineModelTab`：下载文案与 `PY_ENGINE_SIZE` 改为单包体积（约 210MB）

## 6. 迁移与清理

- [ ] 6.1 启动时幂等清理遗留：`userData/sherpa-onnx/{current,staging,previous}`、`userData/py-base/current`、旧式分体 `userData/py-engines/*`（失败仅记日志）
- [ ] 6.2 兼容：旧 manifest 字段缺失时按未安装处理，引导重新下载单运行时

## 7. i18n

- [ ] 7.1 `resources.json`（zh/en）：sherpa 运行库「下载/升级/卸载」相关键改为「已内置/就绪」；保留向后兼容键
- [ ] 7.2 faster-whisper 下载体积/确认文案更新；`node scripts/check-i18n.mjs` 通过

## 8. 校验

- [ ] 8.1 `scripts/check-bundle-size.mjs` 基线更新（−py-base / +sherpa native），跑通
- [ ] 8.2 `npx tsc --noEmit`（renderer 用 `renderer/tsconfig.json`）+ `yarn test:engines` 全绿
- [ ] 8.3 冒烟：全新环境（无任何运行时下载）选 funasr/qwen/fireRedAsr，仅装 ASR 模型即可转写出 SRT
- [ ] 8.4 冒烟：faster-whisper 下载单运行时包后可转写；删除运行时后回到「未安装」并可重新下载
- [ ] 8.5 冒烟（macOS）：签名/公证后内置 `sherpa-onnx.node` 可 dlopen（无 Gatekeeper 拦截）；Windows/Linux 同目录依赖可解析
- [ ] 8.6 跨平台/ISA：确认上游单运行时按 `(os,arch)` 各出一份且 App 下载匹配本机；在较老 CPU（无 AVX2）上 faster-whisper 转写不 `SIGILL`（验证 ct2/onnxruntime 运行时 baseline 派发）；CI 中 `uv pip install` 全程命中 wheel（无 sdist 源码编译）
