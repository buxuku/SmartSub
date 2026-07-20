# Design: unified-storage-root

## Context

现状盘点（详见各文件）：

- 6 个模型目录 + 1 个临时目录 = 7 个独立 settings 键，解析逻辑同构但分散在 7 处，均为「用户覆盖 || userData 默认」，解析时顺手 `mkdirSync`：
  - `modelsPath` → `whisper.ts getPath()`，默认 `userData/whisper-models`
  - `fasterWhisperModelsPath` → `modelCatalog.ts getFasterWhisperModelsPath()`，默认 `userData/faster-whisper-models`
  - `funasrModelsPath` / `qwenModelsPath` / `fireRedModelsPath` / `ttsModelsPath` → 各自 catalog 的 `get*ModelsRoot()`（经 `modelImport.ts resolveOverridePath` trim 判空），默认 `userData/models/{funasr,qwen,firered,tts}`
  - `useCustomTempDir` + `customTempDir` → `fileUtils.ts getTempDir()`，默认 `系统temp/whisper-subtitles`
- 所有下载器、`openModelsFolder`、`getSystemInfo`、HF_HOME 注入（`pythonRuntime/index.ts`）都**实时调用**上述 getter，不缓存路径——在 getter 内插一层即全局生效。
- **`modelsPath` 是唯一写进 store defaults 的绝对路径**（`store/index.ts:23`）。electron-store 的 `get('settings')` 返回 defaults 合并结果，`setSettings` 以 `{...preSettings, ...patch}` 整体回写，因此任意一次设置变更都会把这个绝对默认路径持久化到 config.json。存量用户的 `modelsPath` 与「用户主动自定义」不可区分。
- 中文路径无代码校验，仅 `settings.json` 一句文案；Windows 中文用户名的 `userData` 默认路径本身含中文，是 whisper.cpp/sherpa-onnx 打不开模型文件的历史根源。
- `setSettings`（`ipcStoreHandlers.ts:160-169`）仅在 `fasterWhisperModelsPath` **truthy 且变化**时重启 Python 运行时：清空该键（恢复默认）不会触发，是既有缺陷。
- 产品既有语义：改模型路径**不迁移文件**，toast 提示手动移动或重新下载（`modelsControl.json: modelPathChangedHint`）。

## Goals / Non-Goals

**Goals:**

- 一处设置统一存储根目录，6 个模型目录 + 临时目录全部跟随；单独设置仍优先。
- 中文（CJK）路径在所有目录选择入口被硬阻止，并对「默认路径本身含中文」的用户主动引导。
- 存量用户设置统一目录后 whisper.cpp 一样跟随（modelsPath 归一化）。
- 路径来源（默认 / 统一目录 / 单独设置）在引擎页可见、可恢复跟随。
- 解析核心为纯函数、可脱离 Electron 单测。

**Non-Goals:**

- 不自动迁移已下载的模型/临时文件（沿用既有语义，明确提示）。
- 不纳入 `py-engines`、`addons`、`voiceClones`、`dubbing-sessions`、`logs`（仍在 userData；py-engines/addons 留待后续评估）。
- 不新增 TTS 模型目录的单独覆盖 UI（`ttsModelsPath` 键保留，跟随统一目录已满足需求）。
- 不校验空格、磁盘空间、写权限（选目录系统对话框已保证存在性；mkdir 失败按既有逻辑回退/报错）。

## Decisions

### D1: 新键 `storageRoot` 作为解析链中间层，而非批量赋值

`settings.storageRoot?: string`（undefined/空串 = 未设置）。解析优先级：

```
引擎单独覆盖（既有 7 键） > storageRoot/<既有默认子目录名> > userData/<既有默认子目录名>
```

- 为什么不是「一键批量写入 7 个既有键」：那是快照式赋值，换 root 要再批量写、无法区分「跟随」与「单独设置」、清除语义混乱；中间层是真正的「前缀」语义，来源可判定（UI badge 依赖此）。
- 用户已拍板：单独设置优先生效，不清空；UI 标注来源并提供「恢复跟随统一目录」。

### D2: 子目录布局复用既有默认名

| 用途                          | root 下子路径                       |
| ----------------------------- | ----------------------------------- |
| whisper.cpp (ggml)            | `whisper-models/`                   |
| faster-whisper (CT2)          | `faster-whisper-models/`            |
| FunASR / Qwen / FireRed / TTS | `models/{funasr,qwen,firered,tts}/` |
| 临时文件                      | `temp/`                             |

与 userData 默认布局一一对应（temp 除外，原默认在系统 temp），用户从旧位置手动搬模型时目录名照抄即可。不引入新的层级重组。

### D3: 纯函数解析核心 `main/helpers/storagePaths.ts`

```ts
type StorageSource = 'override' | 'storageRoot' | 'default';
resolveStorageLocation(input: {
  override?: string;      // 该用途的单独覆盖键值
  storageRoot?: string;   // settings.storageRoot
  subpath: string[];      // D2 的子路径段
  defaultBase: string;    // userData 或系统 temp（调用方传入，保持纯函数）
}): { path: string; source: StorageSource }
```

- trim 判空语义与 `resolveOverridePath` 一致（该函数保留，内部改为委托或并存均可，以最小 diff 为准）。
- `mkdirSync` 不进纯函数：各 getter 拿到结果后照旧自行确保目录存在（既有行为，且 temp 有失败回退分支）。
- 6 个 catalog getter + `getTempDir` 全部改为调用此函数；`getSystemInfo` 需要 source，新增一个返回 `{path, source}` 的变体或让 getter 暴露两个口。
- 为什么调用方传 `defaultBase`：`app.getPath()` 不进纯函数，`scripts/test-storage-paths.ts` 可脱离 Electron 直测全部分支。

### D4: 存量 `modelsPath` 归一化（必须，否则功能对老用户失效）

两步：

1. `store/index.ts` defaults 移除 `modelsPath`（`getPath()` 本就有 fallback，行为不变）。
2. `setupStoreHandlers()` 启动迁移（与 gpuMode 迁移并列）：若持久化的 `settings.modelsPath === path.join(userData, 'whisper-models')`，删除该键。

- 代价：真把默认路径手动选回来的用户会被视为「未覆盖」——语义上等价（解析结果相同），设置 root 后开始跟随 root，符合直觉。
- 其余 5 个模型键从未进 defaults，只有用户主动设置过才存在，无需归一化。`customTempDir` 默认 `''`，trim 判空天然豁免。

### D5: 临时目录纳入统一根

`getTempDir()` 优先级：`useCustomTempDir && customTempDir` > `storageRoot/temp` > `系统temp/whisper-subtitles`。

- 显式自定义临时目录是「单独设置」，优先于统一根，与 D1 语义一致。
- `storageRoot/temp` 的 mkdir 失败沿用既有回退：日志 + 落回系统默认。
- `clearCache`（`systemInfoManager.ts`）只删 `.wav/.srt/.bak`，对 `root/temp` 安全，无需改动。
- 设置页既有「自定义临时目录」控件保留，文案补充与统一目录的优先级说明。

### D6: 中文路径硬阻止，校验收口 `types/pathValidation.ts`

纯函数（无 Electron/Node 依赖，主进程与渲染层共享，先例 `types/provider.ts`）：

```ts
containsCjk(p: string): boolean   // 覆盖 CJK 统一表意文字 + 扩展A + 兼容表意 + CJK 标点 + 全角形式
validateStoragePath(p: string): { ok: true } | { ok: false; reason: 'cjk' }
```

三层执法：

1. **渲染层选路时（主执法）**：统一根目录、5 个引擎「更改」、自定义临时目录共 7 个入口，`selectDirectory` 返回后先校验，失败 → destructive toast（说明 whisper.cpp/sherpa-onnx 无法读取中文路径）+ 不保存。
2. **主进程 `setSettings` 兜底**：对 8 个路径键（`storageRoot` + 7 既有键）逐键检查，含 CJK 的键从 patch 中剔除并 `logMessage` warn——覆盖配置导入（`configExporter`）等旁路写入。
3. **默认路径含中文的主动引导**：设置页存储区块内，`storageRoot` 未设置且 `containsCjk(默认根)` 时展示常驻警示（建议设置纯英文统一目录）。渲染层用 `getSystemInfo` 已返回的解析路径自行判定，主进程零新增。

- 为什么阻止 CJK 而非全部非 ASCII：已知故障面是 CJK（fopen ANSI codepage 问题），用户明确要求「禁止中文路径」；拉黑全部非 ASCII 会误伤西文变音符等无风险场景。
- 默认路径含中文不阻止（用户没得选），只引导。

### D7: Python 运行时重启改为「CT2 有效根目录变化」判定

`setSettings` 中：写入前后分别用 D3 纯函数解析 CT2 有效路径（pre/post settings 各算一次），不等则 `shutdownPythonRuntime()`。

- 覆盖三个场景：改 `fasterWhisperModelsPath`（既有）、设置/清除 `storageRoot`（新）、清空 `fasterWhisperModelsPath` 恢复跟随（既有缺陷，顺带修复）。
- HF_HOME/HF_HUB_CACHE 在 runtime respawn 时重新计算（`pythonRuntime/index.ts:21-27`），无需额外处理。
- CT2 有单独覆盖时设置 root 不触发重启（有效路径未变）——判定天然正确。

### D8: UI——设置页「存储位置」区块 + 引擎页来源标识

- **设置页**（`settings.tsx`）：新区块置于既有临时目录控件之前，两者归入同一「存储位置」分组：
  - 统一根目录行：当前值（未设置时显示「跟随系统默认」+ 实际 userData 路径）、「浏览」「打开目录」「清除」；
  - 设置/清除后 toast 提示「仅改变读写位置，已下载模型不会自动迁移」（复用 `modelPathChangedHint` 语义）；
  - D6-3 的中文默认路径警示。
- **引擎页**（`ModelLibrarySection.tsx`）：路径行已展示解析后路径；新增来源 Badge（默认 / 统一目录 / 单独设置，数据来自 `getSystemInfo` 新增的 per-engine source），source 为 `override` 且 `storageRoot` 已设置时显示「恢复跟随统一目录」按钮（`setSettings({ [key]: '' })`，D7 保证 CT2 场景正确重启）。
- `getSystemInfo` 返回值新增：`storageRoot`（原始设置值）与 `modelPathSources: Record<'ggml'|'ct2'|'funasr'|'qwen'|'firered', StorageSource>`（TTS 无 UI 不需要）。

### D9: 不迁移文件 + 明确预期管理

设置/更换/清除 `storageRoot` 后：旧目录文件原样保留，新目录按需 mkdir，引擎页模型清单按新路径重扫（`getSystemInfo` 实时解析，无缓存失效问题）；进行中的下载按既有 changePath 行为处理（断点状态自愈到新路径重下）。

预期管理升级为「新旧位置对照」对话框（低成本替代自动迁移）：变更成功后弹对话框展示旧位置/新位置 + 「打开旧目录」「打开新目录」按钮 + 子目录同名可整体复制的说明 + 单独设置引擎不受影响的注记；旧位置无变化（首次设置且等值等边界）时退回 toast。「打开旧目录」走新增 `openDirectoryPath` IPC（不存在时报错、不创建）。设置区块 hint 保留。自动迁移/迁移助手明确不做（评估结论：跨盘 copy+校验+进度+任务/下载/运行时句柄门禁，成本≈整个本 change，一次性操作收益不成比例），若未来要做立独立 change。

### D10: 首次引导前置存储位置决策

在既有 `OnboardingDialog` 第 2 步（模型下载）顶部内联一行「存储位置：<当前解析基座> [更改]」，并在默认基座含 CJK 时就地展示黄色警示——下载前是改目录的零迁移成本时刻，也是拦截中文路径故障的最佳位置。

- 仅 `installedCount === 0`（无已装模型）时展示：已有模型的用户在引导里改目录会导致模型「消失」（不跟随），避免误导。
- 不加独立引导步骤：默认路径可用的多数用户不需要此决策，内联行零流程摩擦。
- 数据复用该弹窗已有的 `getSystemInfo` 调用（`storageRoot`/`userDataPath`）；选路校验与设置页同源（`validateStoragePath`）；文案在 `common.json` 的 `onboarding.*` 命名空间。

## Risks / Trade-offs

- **electron-store defaults 移除 `modelsPath`**：`getPath()` 与 `getGgmlModelsPath()` 均有 fallback，`grep settings.modelsPath` 全仓核对无裸读；风险低。
- **归一化误判**：用户「主动选了默认路径」被归为未覆盖——解析结果不变，仅未来跟随 root，可接受（D4）。
- **CJK 兜底剔除是静默的**（仅日志）：配置导入含中文路径时对应键不落库，用户感知靠引导提示；显式报错通道留待有真实反馈再加。
- **`storageRoot` 指到只读/可移动盘**：mkdir 失败时各 getter 既有行为是抛错或回退（temp 有回退，模型目录抛错），与现在单独设置指到坏路径的行为一致，不新增处理。

## Test Plan

- `scripts/test-storage-paths.ts`（`npm run test:storage-paths`，仿 `test-thinking-control` 模式）：
  - `resolveStorageLocation` 全分支：覆盖優先 / root 生效 / 默认回退 / trim 判空 / source 判定；
  - 子目录映射表逐引擎断言；temp 三级优先级；
  - `containsCjk` / `validateStoragePath`：中文、CJK 标点、全角、纯英文、西文变音符（不拦截）、空串；
  - `modelsPath` 归一化判定函数（等于默认删除、自定义保留）。
- `npm run check:i18n` 通过。
- 手工清单（真机）：设置 root 后 6 引擎路径与 temp 跟随、下载落位新目录、CT2 触发 python 重启、单独覆盖优先与恢复跟随、选中文目录被拒、中文默认路径警示展示。
