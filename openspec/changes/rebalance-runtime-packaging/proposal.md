## Why

「三层架构」当初抽离 Python 基座（Layer1）+ 可重定位引擎包（Layer2），是为了让 faster-whisper / funasr / qwen 多个 **Python** 引擎共用一套基座。但 funasr / qwen / fireRedAsr 已全部迁移到 **sherpa-onnx 原生运行库**，不再是 Python 引擎（见 `types/engine.ts`：`PyEngineId = 'faster-whisper'` 已塌缩为单值，注释明示 "funasr 已迁移到 sherpa-onnx 原生运行库，不再是 Python 引擎"）。于是出现两处与实际使用不匹配的打包策略：

- **被内置的是「重而单用」的东西**：`extraResources/py-base`（实测 **41MB**，每个平台安装包都带）只服务 faster-whisper 一个引擎，绝大多数只用 builtin / sherpa 引擎的用户白白背负。
- **被下载的是「轻而多用」的东西**：sherpa-onnx 原生库（面板标注 `RUNTIME_SIZE = '20MB'`）服务 funasr / qwen / fireRedAsr 三个引擎，却在运行时下载，带来首次使用门槛与下载/重签/自检的失败面（`sherpaLibDownloader.ts` 的多源回退 + macOS `resignMac` + 子进程 `assertLoadable`）。

把这两件事对调，让「内置 / 下载」与「使用频率 / 收益面」对齐：**内置那个服务三引擎的小东西，下载那个只服务单引擎的大东西**。

## What Changes

- **sherpa-onnx 原生运行库改为随应用内置**：像 whisper.cpp 的 `addon.node` 一样走 `extraResources`（避开 asar 内 `.node` 无法 dlopen 的限制——该限制只针对 asar，extraResources 不受限）。funasr / qwen / fireRedAsr 安装后**开箱即用、零运行时下载**；退役运行时下载器、staging→current 原子替换、运行时 macOS 重签与子进程自检、以及 sherpa 运行库的下载 / 升级 / 卸载 IPC 与面板入口。macOS 的 `@rpath→@loader_path` 改写 + 签名改在**构建期**完成（配合 Developer ID 签名 / 公证，比运行时 ad-hoc 重签更稳）。
- **faster-whisper 彻底塌缩为单个自包含「运行时」下载包（A1：PBS + uv，非 PyInstaller）**：不再区分 Layer1 基座 / Layer2 引擎包，py-engine 仓为每个 `(os,arch)` 发布**一个**自包含运行时产物（python-build-standalone 解释器 + `uv` 解析的官方平台 wheel + main.py）。应用**不再内置** `extraResources/py-base`；faster-whisper 首次使用时按需下载该单包。随之退役多引擎三层机制（`enginePackages` / `RemoteBasePackage` 独立基座下载 / 内置基座回退 `getBuiltinPyBaseDir`），并移除「缺基座 → 重装/升级 App」错误态（基座已含在运行时包内）。（已评估并否决回退 PyInstaller 冻结方案：上游 `015276b` 因「correct native wheels」将其移除，跨平台原生库脆弱 + mac 公证 / Windows 杀软误报更高；A1 复用 uv 正确 wheel 解析更稳。）
- **安装包体积再平衡**：移除 py-base（−41MB）、内置 sherpa（+20MB），净约 **−21MB / 平台**，且 sherpa 三引擎转为完全离线可用。
- **不在本次范围**：不改各 ASR / ggml / CT2 模型仍走在线下载的策略；不改 whisper.cpp 的 CUDA / Vulkan addon 下载（属 builtin 引擎，另案）；不改翻译服务。

## Capabilities

### New Capabilities

<!-- 无新增能力；本变更细化既有 engine-model-management 在「运行时获取（内置 vs 下载）」上的契约。 -->

### Modified Capabilities

- `engine-model-management`: 新增两条运行时获取需求——(1) sherpa 系引擎（funasr / qwen / fireRedAsr）的原生运行库随应用内置、与运行时下载解耦；(2) faster-whisper 运行时以单一自包含包按需下载、不随应用内置。

## Impact

- **构建 / 资源**：
  - 新增 `scripts/fetch-sherpa-native.mjs`（按 host 平台拉取 sherpa-onnx 原生库 + 依赖到 `extraResources/sherpa/native/<platformKey>/`，构建期做 macOS `@loader_path` 改写）；与 `scripts/fetch-python-base.mjs` 同惯例（在目标平台 runner 上运行）。
  - `electron-builder.yml`：移除三处 `extraResources/py-base/` 块；`extraResources/sherpa/` 已整目录拷贝（含新增 native 子目录），无需新增；确认 macOS 签名覆盖 `extraResources/sherpa/native` 下的 `.node` / `.dylib`。
  - 退役 `scripts/fetch-python-base.mjs`（或改为「获取单一 faster-whisper 运行时」的本地构建辅助，仅 CI/发布用）。
- **主进程**：
  - `sherpaOnnx/sherpaLibPaths.ts`：`getSherpaLibDir()` 指向内置 `getExtraResourcesPath()/sherpa/native/<platformKey>`；`isSherpaLibInstalled()` 基于内置存在性（正常安装恒真）。退役 `sherpaLibDownloader.ts`、`sherpaLibManager.ts` 的 staging/promote/rollback、运行时 `resignMac` / `assertLoadable`。
  - `pythonRuntime/paths.ts`：塌缩为单一运行时目录解析；退役 `getBuiltinPyBaseDir` / `resolvePyBaseDir` 的内置回退、`enginePackages` / `basePackage` 相关 URL/manifest IO；`downloader.ts` 改为下载单包并解包到运行时目录；`manager.ts` 从运行时内嵌解释器启动。
  - `fasterWhisperEngine.ts#isAvailable`：以「运行时包已安装」为唯一就绪判据，移除 `isPyBaseReady()` 的 error 分支。
  - IPC：移除 sherpa 运行库下载/升级/卸载与（如有）基座升级相关处理；faster-whisper 下载进度沿用现有 `py-engine-download-progress`。
- **渲染层**：`SherpaRuntimePanel` 移除下载/升级/卸载与进度 UI（sherpa 标注「已内置」，引擎就绪只看 ASR 模型）；`EngineModelTab` 移除 `useSherpaRuntime` 的下载态依赖；`FasterWhisperPanel` 下载文案改为单包体积（约 210MB）。
- **i18n**：`resources` namespace 调整 sherpa 运行库相关文案（下载→已内置）、faster-whisper 下载体积文案；zh/en 同步。
- **上游依赖（py-engine 仓，纳入本计划）**：新增 `build_runtime_package.py` 出单运行时、CI 按 `(os,arch)` 矩阵（`--only-binary=:all:`、PBS baseline）发布 `smartsub-faster-whisper-runtime-<suffix>.tar.gz` + `manifest.json`（sha256 / size / python / protocol / engine 版本）、退役 base/engine 双产物；**保留** `sherpa-libs-latest` 供 App 构建期内置 sherpa（D1）。
- **迁移**：启动时可选清理历史遗留的 `userData/sherpa-onnx/*` 与 `userData/py-base/current`、`userData/py-engines/*`（解析已优先内置/新运行时，遗留目录仅占空间）。
- **不变**：builtin（whisper.cpp）运行时与其 addon 下载、各 ASR / ggml / CT2 模型下载与下载源回退、共享 VAD 内置（已由 `unify-model-path-and-import` 落地）。
