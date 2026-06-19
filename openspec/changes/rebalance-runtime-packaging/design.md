## Context

当前打包与「使用频率 / 收益面」错配（实测）：

| 资源                                      | 现状                            | 体积   | 收益面                              |
| ----------------------------------------- | ------------------------------- | ------ | ----------------------------------- |
| `extraResources/py-base`（CPython）       | **内置**（每平台安装包）        | 41MB   | 仅 faster-whisper 1 个引擎          |
| sherpa-onnx 原生库（`.node`+onnxruntime） | **运行时下载**                  | ~20MB  | funasr / qwen / fireRedAsr 3 个引擎 |
| whisper.cpp `addon.node`                  | 内置（`extraResources/addons`） | 6MB    | builtin                             |
| faster-whisper 引擎包（site-packages）    | 运行时下载                      | ~170MB | faster-whisper                      |

三层架构的多引擎共享前提已消失：`PyEngineId` 仅剩 `'faster-whisper'`。本设计把「内置 ↔ 下载」对调，并把仅剩单消费者的三层机制塌缩为单包。

## Goals / Non-Goals

**Goals**

- sherpa 三引擎安装后零运行时下载即可用（仅 ASR 模型需下载）。
- faster-whisper 以单一自包含运行时包按需下载，应用不再内置 Python 基座。
- 安装包净瘦身（约 −21MB/平台），并显著缩小 sherpa 运行库的失败面（下载/重签/自检全部消失）。

**Non-Goals**

- 不改 ASR / ggml / CT2 模型的在线下载与下载源回退。
- 不改 whisper.cpp CUDA/Vulkan addon 管理（另案 fold-gpu-into-builtin）。
- 不在应用内提供 sherpa 运行库的「升级」（改随 App 版本走）。

## Decisions

### D1 — sherpa 原生库随应用内置，构建期完成 macOS 兼容处理

- **布局**：`extraResources/sherpa/native/<platformKey>/`（`platformKey` 沿用 `getSherpaPlatformKey()`：`darwin-arm64` / `win-x64` / `linux-x64` …）。每个发布产物只含 host 平台目录（与 py-base 同惯例：在目标平台 runner 上 fetch）。
- **获取**：新增 `scripts/fetch-sherpa-native.mjs`，从 py-engine 同仓（`buxuku/smartsub-py-engine` 的 `sherpa-libs-latest`）拉取并解包到上述目录，构建期对 macOS 执行 `otool`/`install_name_tool` 的 `@rpath→@loader_path` 改写（把现 `sherpaLibDownloader.resignMac` 的逻辑前移到构建脚本）。
- **签名**：依赖 electron-builder 的 macOS 签名覆盖 `extraResources/sherpa/native` 下 `.node`/`.dylib`（Developer ID + 公证），取代运行时 ad-hoc 重签。
- **运行时解析**：`getSherpaLibDir()` → 内置目录；`isSherpaLibInstalled()` → 基于内置文件存在性（恒真）。`getSherpaNativePath()` 不变（同目录内 `sherpa-onnx.node`）。
- **理由**：whisper.cpp 的 `addon.node` 已证明 extraResources 内的原生 `.node` 可正常 dlopen；"asar 内 .node 不可 dlopen" 的限制不适用于 extraResources。

### D2 — faster-whisper 塌缩为单个自包含「运行时」包（A1：PBS + uv，非 PyInstaller）

- **机制（A1）**：py-engine 仓为每个 `(os,arch)` 发布**一个**自包含运行时 `smartsub-faster-whisper-runtime-<suffix>.tar.gz`，内含：
  - **可重定位 CPython**：python-build-standalone（PBS），经 `uv python install 3.12.10` 获取（默认 `install_only` **baseline** 变体，非微架构优化版）——与本仓现有 `fetch-python-base.mjs` / 上游 `build_base_package.py` 同一解释器，本就在生产运行。
  - **site-packages**：`uv pip install --only-binary=:all: -r requirements-faster-whisper.txt` 解析的**官方平台 wheel**（manylinux / macosx / win_amd64）；原生依赖（ctranslate2 / av / tokenizers / onnxruntime）由上游 delocate/auditwheel/delvewheel 预捆绑、rpath 相对化。
  - **sidecar 源码**：`main.py` + `_version.py` + `engines/`。
- **本质**：把「不再被任何引擎共享」的基座**合并回引擎包**（funasr 已于上游 `0ae1f0c` 移除 Python 版、改用 node sherpa addon，faster-whisper 成为唯一 Python 引擎）。执行模型与今天**完全一致**（spawn PBS 解释器 + `PYTHONHOME`=运行时根 + `PYTHONPATH`=运行时/site-packages + `main.py`），仅改打包位置（解释器与依赖合到一个 tar）。
- **为何不用 PyInstaller（A2，已评估并否决）**：上游最初（`3073e38`）用 PyInstaller onedir，已于 `015276b` 因「correct native wheels」**主动移除**。PyInstaller 的 hook 收集 ct2/av/onnxruntime 原生库跨平台脆弱（常仅在某平台运行时才暴露缺库）、macOS bootloader 的 hardened-runtime / 公证更难、Windows 杀软误报更高。A1 复用 uv 的正确 wheel 解析（即当年替换 PyInstaller 的修复），跨平台更稳，且 macOS 仅需对普通 `.dylib/.so` 重签（现有逻辑已覆盖），无自定义 bootloader 需公证。
- **跨平台构建加固（决定性，写入 CI）**：
  - **`(os,arch)` 矩阵**：在各自匹配 runner 上每 `(os,arch)` 出一份（macos-arm64 / macos-x64 / windows-x64 / linux-x64）——架构维度必须匹配、不可交叉。
  - **runner 不编译**：`uv pip install --only-binary=:all:` 禁止 sdist 在 runner 源码编译（这是唯一可能把 runner CPU 的 `-march` 烘进产物的路径）；PBS 为预构建 baseline，亦不在 runner 编译。
  - **运行时 ISA 派发**：ct2 / onnxruntime / numpy / ffmpeg(av) 在运行时检测 AVX/AVX2/AVX-512，老 CPU 自动走 baseline 内核，不会 `SIGILL`。
- **落地（应用侧）**：下载解包到 `userData/py-engines/faster-whisper`（含内嵌解释器）；`manager.ts` 用该内嵌解释器 spawn；`paths.ts` 退役 `getBuiltinPyBaseDir` / `resolvePyBaseDir` 的内置回退、`RemoteBasePackage` 独立基座下载、`enginePackages` 多引擎桶；`PyEngineManifest` 精简为单运行时所需字段。
- **就绪判定**：`fasterWhisperEngine.isAvailable()` 仅判「运行时包已安装（解释器 + main.py + site-packages 存在）」；删除 `isPyBaseReady()` 的 `error: 'Python base runtime missing; reinstall...'` 分支。
- **理由**：单消费者下，base/engine 分层的「多引擎共享」收益为零；合并为单包后流程更简单（一个下载、一个就绪态、一个升级维度），且不重蹈 PyInstaller 的跨平台原生库覆辙。

### D5 — 上游 py-engine 仓改造（前置依赖，纳入本计划）

`smartsub-py-engine` 现状：funasr 的 Python 版已移除（`0ae1f0c`），faster-whisper 是唯一 Python 引擎；仓内并存 `build_base_package.py`（PBS 基座）+ `build_engine_package.py`（main.py+site-packages）双产物，以及 `sherpa-libs-latest`（sherpa 原生库，供 App 构建期内置消费——见 D1）。本变更要求上游：

- **新增** `build_runtime_package.py`：合并「PBS 基座（baseline，`uv python install`）+ `uv pip install --only-binary=:all:` 的 site-packages + main.py/engines」到单一 OUT 目录；macOS 对全部 `.dylib/.so` ad-hoc 重签；包模式 smoke（基座解释器 + `PYTHONPATH` 跑 main.py，`find_spec('faster_whisper')`）。
- **CI**（`release.yml`）：`(os,arch)` 矩阵在匹配 runner 上产出 `smartsub-faster-whisper-runtime-<suffix>.tar.gz`；发布到滚动 `latest`；`manifest.json` 暴露运行时 `artifact` / `sha256` / `size` / `pythonVersion` / `protocolVersion` / `engineVersion`；`checksums.sha256` 收录运行时包。
- **退役**：`build_base_package.py` / `build_engine_package.py` 与 `smartsub-base-*` / `smartsub-<engineId>-*` 产物及 `manifest.basePackage` / `enginePackages`（faster-whisper 单引擎单运行时，无需分层）。**保留** `sherpa-libs-latest` 供 App 构建期消费。
- **README**：更新为「单运行时包」分发说明。

应用侧以可配置常量（产物名 / URL）落地，待上游产物就绪即可联调。

### D3 — 体积与离线性

- 安装包：−41MB（py-base）+20MB（sherpa native）≈ **−21MB**。
- 离线性：builtin + funasr/qwen/fireRedAsr 安装后**完全离线**（仅 ASR/ggml 模型可选下载）；faster-whisper 需一次约 210MB（基座+lib 合一）下载。
- `scripts/check-bundle-size.mjs` 基线相应更新。

### D4 — 迁移与回退（A1 单运行时）

- 历史遗留（启动时一次幂等清理，失败仅记日志、不阻断）：旧版 `userData/sherpa-onnx/{current,staging,previous}`（sherpa 改内置）、`userData/py-base/current`（下载基座，A1 后不再使用——基座已并入运行时）、旧式分体 `userData/py-engines/faster-whisper`（base+engine 分体或纯 site-packages 无内嵌解释器）。后者缺内嵌解释器即判「未安装」，引导重下单运行时。
- 回退：sherpa「运行时回滚」随 App 版本（不再单独）；faster-whisper 运行时损坏 / 校验失败 → **覆盖式重下单运行时包**（不再有独立基座升级维度）。
- 版本 / 协议：单运行时包的 `protocolVersion` / `engineVersion` / `pythonVersion` 经 `manifest.json` 暴露，沿用现有协议区间门禁（`protocolSupport.ts`）。

## Risks / Trade-offs

- **构建管线复杂度上移**：sherpa native 的获取 + macOS 改写/签名 + 跨平台 runner 矩阵需在 CI 固化。缓解：复用 `fetch-python-base.mjs` 的「host=target」约定，新增 `fetch-sherpa-native.mjs` 同构。
- **sherpa 升级丧失应用内通道**：版本 bump 需发 App 版本。缓解：sherpa 版本相对稳定（当前 `SHERPA_VERSION='1.13.2'`），且去掉运行时下载换来更小失败面，权衡可接受。
- **py-engine 仓需新增「单运行时包」产物**：属本仓外依赖。缓解：在 tasks 标注为前置依赖，应用侧 URL/产物名以可配置常量落地，待产物就绪即可联调。
- **faster-whisper 单包更大（~210MB vs 现 170MB）**：首次下载更重。权衡：换来「无内置基座、无重装提示、单一就绪态」，且仅 faster-whisper 用户承担。

## Migration Plan

1. 上游 py-engine 仓（D5）：新增 `build_runtime_package.py` 出单运行时包、CI 按 `(os,arch)` 矩阵（`--only-binary=:all:`、PBS baseline）发布、退役 base/engine 双产物；确认 `sherpa-libs-latest` 可被 App 构建脚本消费（前置依赖）。
2. 加 `fetch-sherpa-native.mjs`，本地/CI 产出 `extraResources/sherpa/native/<platformKey>/`；改 `electron-builder.yml`（去 py-base，校验 sherpa 签名）。
3. 主进程切换解析路径（sherpa 内置、faster-whisper 单运行时），退役下载/分层代码与 IPC。
4. 渲染层去掉 sherpa 下载 UI、改 faster-whisper 文案。
5. 启动迁移清理 + 冒烟（全离线装 sherpa 引擎可转写；faster-whisper 单包下载后可转写；macOS 签名/公证通过 dlopen）。

## Open Questions

- ~~单运行时包是否需要按 CPU 指令集（AVX2 等）再分档？~~ → **已定：不分档**。PBS baseline + 运行时 ISA 派发（ct2/onnxruntime/numpy/av）已覆盖老 CPU、无 `SIGILL` 风险；`--only-binary=:all:` 杜绝 runner 源码编译把 CPU 特性烘入产物。
- 是否保留极少数高级用户的「自定义 sherpa 运行库路径」逃生口？（暂不保留，内置即唯一来源；如需再议。）
