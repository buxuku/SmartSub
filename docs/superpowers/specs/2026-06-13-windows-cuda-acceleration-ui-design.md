# Windows CUDA 加速模块 UI/UX redesign 设计规格

> 状态：已评审 · 实施中  
> 日期：2026-06-13  
> 范围：资源中心「加速」Tab · Windows（含 Linux 桌面 GPU 平台，逻辑同构）  
> 平台排除：macOS（维持现有「状态 + 检测详情」精简形态，不引入 CUDA Sheet）  
> 关联：`GpuAccelerationCard.tsx`、`cudaUtils.ts` `getAddonRecommendation()`、`VULKAN_GPU_ACCELERATION_PLAN.md`

---

## 1. 背景与目标

### 1.1 用户确认的设计方向

- **优先级**：降低理解成本 — 95% 用户只需看懂状态 + 完成一次升级，专家选项尽量藏深。
- **方案**：**方案 1 — 一键升级 + 下载确认 Sheet**。
- **页面分区**：A 状态 Hero · B 加速模式 · C 当前后端 · D 更多（默认折叠）。

### 1.2 要解决的问题（摘要）

| 类别     | 问题                                                     |
| -------- | -------------------------------------------------------- |
| 信息密度 | CUDA 版本矩阵、完整/轻量版概念以 11px 大段文字堆在折叠区 |
| 交互模式 | 后端下拉同时承担「切换」与「下载」，不符合常规           |
| 空间分离 | 下载操作与下载源相距远，首次下载需展开高级选项           |
| 决策缺失 | 首次下载无法选择完整/轻量；推荐逻辑未 surfaced           |
| 架构混乱 | 运行时策略（加速模式）与资源管理（包安装）同层展示       |

### 1.3 成功标准

1. N 卡新用户在不展开「更多」的情况下，能完成 CUDA 升级全流程。
2. 升级按钮与 Sheet 内均可见：**版本 · 包类型 · 预估体积 · 推荐理由 · 下载源**。
3. 后端切换不再触发隐式下载；下载仅通过 Sheet 或已安装项的「更新」按钮发起。
4. 下载失败时提供 **切换镜像并重试** 的一键操作。

### 1.4 非目标（本期不做）

- 不改变 `start-addon-download` IPC 协议与 addon 存储结构。
- 不新增远程 manifest 的体积字段（先用文案级预估，见 §5.4）。
- 不重做 macOS Metal/CoreML 体验。
- 不将加速 Tab 改为与模型 Tab 完全相同的卡片目录（与「一键路径」方向冲突）。

---

## 2. 设计原则

1. **一个主操作**：任意时刻页面最多一个主 CTA（升级 / 下载中 / 已是最优则无）。
2. **下载 = 确认式流程**：所有新装/跨版本/跨包类型下载均经 Sheet 确认，禁止下拉隐式下载。
3. **推荐可见、可改**：系统默认选好，用户可改但不强迫理解 CUDA 生态。
4. **决策就近**：下载源、包类型、版本选择与「开始下载」同处 Sheet。
5. **与资源中心一致**：Hero 状态 + 折叠专家区；模型 Tab 的「下载源置顶」经验吸收到 Sheet 内。

---

## 3. 页面信息架构（四区块）

```
┌─ GPU 加速 ──────────────────────────────────────────────┐
│  [A] 状态 Hero                                          │
│  [B] 加速模式（三选一）                                  │
│  [C] 当前后端（切换已安装项，不下载）                    │
│  [D] 更多 ▾（默认折叠）                                  │
└─────────────────────────────────────────────────────────┘
```

### 3.1 区块 A — 状态 Hero（始终可见）

**保留并增强**现有状态卡（绿/黄/灰语义、GPU 名、驱动版本）。

| 状态                             | 主 CTA                                                       |
| -------------------------------- | ------------------------------------------------------------ |
| GPU 运行中 · Vulkan（N 卡）      | 「升级到 CUDA {ver}（{edition} · ~{size}）」→ 打开 Sheet     |
| GPU 运行中 · CUDA                | 无（可选次要链：「管理已安装包」展开 D）                     |
| GPU 运行中 · Vulkan（A 卡/核显） | 无                                                           |
| 降级 / CPU                       | 视原因显示「查看原因」或修复建议，无 CUDA 升级               |
| 下载进行中                       | Hero 下方 inline 进度条（复用现有 `renderDownloadProgress`） |

**升级 CTA 文案**（相对现状增强）：

- 中文示例：`升级到 CUDA 12.4.0（完整版 · 约 1.4 GB）`
- 英文示例：`Upgrade to CUDA 12.4.0 (Full · ~1.4 GB)`
- 版本、包类型、体积均来自 §5 的 Sheet 默认项，Hero 与 Sheet 保持一致。

**升级提示行**（`upgradeHint`）保留；其下增加一行 **推荐理由**（`gpuEnv.nvidia.recommendation.reason`），例如：

> 未检测到 CUDA Toolkit，推荐下载完整版加速包

### 3.2 区块 B — 加速模式（始终可见）

保持现有三卡片：自动（推荐）/ 仅 GPU / 仅 CPU。

- 文案与交互不变。
- 视觉上与区块 C 之间增加 `分隔线` 或 `section 标题`，明确「这是运行策略，不是安装资源」。

### 3.3 区块 C — 当前后端（始终可见，替代原「高级选项」内的后端下拉）

**目的**：只切换**已可用**的后端，不承担下载职责。

**布局**：横向 Radio 组或 Segmented Control（2~4 项，动态生成）：

| 选项             | 条件                     | 行为                                          |
| ---------------- | ------------------------ | --------------------------------------------- |
| Vulkan（内置）   | `builtinVulkanAvailable` | `select-addon-version(null)`                  |
| Vulkan（已下载） | 已安装 vulkan            | 选中 userData vulkan                          |
| CUDA {ver}       | 各已安装 CUDA 版本       | `select-addon-version(ver)`                   |
| 自定义           | `customAddonPath` 存在   | 显示「自定义」badge，不可与其他项互切除非清除 |

**未安装 CUDA 时**：

- 不放入 Radio 组。
- 在组下方显示一行次要文字 + 链接：`需要 CUDA 加速？` → `[下载 CUDA 加速包]` 打开 Sheet（与 Hero CTA 相同入口）。

**移除**：原 `Select` 后端下拉及「未安装，选择后开始下载」文案。

### 3.4 区块 D — 更多（默认折叠）

折叠标题：`更多选项`

| 子区块       | 内容                                         | 变更                                             |
| ------------ | -------------------------------------------- | ------------------------------------------------ |
| 已安装管理   | 内置 Vulkan 行 + userData 列表 · 更新 · 删除 | 从原高级区移入；「更新」打开 Sheet（预填该版本） |
| 自定义加速包 | 现有选择文件 / 清除 / 外链                   | 不变                                             |
| 检测详情     | 现有诊断列表 + 复制                          | 不变                                             |
| 闪退提示     | 现有 info 条                                 | 不变                                             |

**移出 D 的内容**（不再出现在页面其他位置）：

- 下载源下拉（仅在 Sheet）
- 完整/轻量三大段说明（收敛为 Sheet 内两卡片 + 一行推荐说明）
- 原「CUDA 包类型」行（合并进 Sheet）
- 原「加速后端」下拉

---

## 4. 下载确认 Sheet

### 4.1 触发入口

1. Hero 主 CTA「升级到 CUDA …」
2. 区块 C 次要链「下载 CUDA 加速包」
3. 区块 D 已安装项的「更新」按钮
4. （可选）下载失败 toast 的「重试」→ 直接重开 Sheet 并保留上次选项

**组件**：使用现有 `Sheet`（`side="right"`，`sm:max-w-md`），标题：`下载 CUDA 加速包` / `Download CUDA Pack`。

### 4.2 Sheet 内容结构（自上而下）

```
┌─ 下载 CUDA 加速包 ────────────────────────┐
│ ① 推荐理由（1 行，来自 recommendation.reason） │
│                                              │
│ ② CUDA 版本                                  │
│    [ 12.4.0 ★推荐 ] [ 13.0.2 ] [ 12.2.0 ] …  │
│    （仅展示驱动兼容的版本；推荐项默认选中）     │
│                                              │
│ ③ 包类型（Radio 两卡片）                      │
│    ┌──────────────┐  ┌──────────────┐        │
│    │ 完整版 ★推荐  │  │ 轻量版       │        │
│    │ ~1.4 GB      │  │ ~150 MB      │        │
│    │ 开箱即用     │  │ 需本机 Toolkit│        │
│    └──────────────┘  └──────────────┘        │
│    （Toolkit 已安装时默认轻量版，否则完整版）   │
│                                              │
│ ④ 下载源                                      │
│    ( ) GitHub   (●) GitHub 代理（国内加速）   │
│                                              │
│ ⑤ [ 开始下载 ]          [ 取消 ]              │
└──────────────────────────────────────────────┘
```

### 4.3 版本选择（②）

- 数据源：`AVAILABLE_CUDA_VERSIONS`，过滤规则与 `getRecommendedAddonVersion(maxCudaVersion)` 一致 — 仅展示 **≤ 驱动最高 CUDA** 的版本。
- 默认选中：`gpuEnv.nvidia.recommendation.recommendedVersion`。
- 推荐项 badge：`推荐`；非推荐但可选的旧版本 tooltip：`兼容旧驱动`。
- 超出驱动能力的版本 **不展示**（而非置灰），减少矩阵噪音。
- 若仅一个可选版本，仍显示但无切换 UI（只读 badge）。

### 4.4 包类型选择（③）

**两卡片 Radio**（非下拉）：

| 类型        | 对应下载                     | 预估体积（文案） | 适用说明                    |
| ----------- | ---------------------------- | ---------------- | --------------------------- |
| 完整版 Full | `tar.gz` / `needsDlls: true` | 约 1.2–1.5 GB    | 无需 CUDA Toolkit，开箱即用 |
| 轻量版 Lite | `node.gz`                    | 约 130–180 MB    | 需本机已安装 CUDA Toolkit   |

**默认选中逻辑**（与 `getAddonRecommendation` 一致）：

```
toolkit.installed → 默认轻量版，完整版卡片仍可手动选
!toolkit.installed → 默认完整版，轻量版卡片显示次要提示「需先安装 CUDA Toolkit」
```

**推荐 badge**：默认项显示 `推荐`；切换非默认项时不阻止，仅在轻量版且 Toolkit 未安装时，「开始下载」按钮 **disabled**，并显示 inline 警告 + 链接到 NVIDIA CUDA 下载页。

**已安装同版本不同包类型**：Sheet 预填当前版本，另一类型高亮为「切换为完整版/轻量版」，行为等同重新下载。

### 4.5 下载源（④）

- 与「开始下载」同处 Sheet 底部操作区上方。
- 选项：`github` | `ghproxy`（沿用现有 `DownloadSource`）。
- 持久化：写入 `localStorage` key `addonDownloadSource`（新 key，避免与模型 `downSource` 混淆）；默认国内用户可默认 `ghproxy`（**可选**：首次按 locale `zh` 默认 proxy，否则 github — 实现时二选一，建议跟模型 Tab 一样用户手动选、不猜）。

### 4.6 主操作（⑤）

- **开始下载**：调用现有 `start-addon-download`，参数 `{ source, variant, type }`，`type` 由包类型决定。
- Sheet **关闭**，进度在 Hero 下方 global 展示（与现有一致）。
- **取消**：关闭 Sheet，不发起下载。

### 4.7 下载中 / 完成后

- 下载中：Hero CTA disabled；Sheet 不可再次打开（或打开为只读进度态 — **推荐**直接 disabled 避免重复任务）。
- 完成：toast + 自动 `select-addon-version`（现有主进程行为）+ 刷新状态；区块 C 自动出现新 CUDA 项。
- 失败：toast 含 **「切换镜像并重试」** 按钮 → 切 `ghproxy`（若当前为 github）并重开 Sheet。

---

## 5. 推荐逻辑（UI 层）

后端逻辑已存在于 `getAddonRecommendation()`，UI 需 **完整暴露** 以下字段：

| 字段                 | UI 位置                                 |
| -------------------- | --------------------------------------- |
| `recommendedVersion` | Sheet 默认版本；Hero CTA 版本段         |
| `needsDlls`          | Sheet 默认包类型                        |
| `reason`             | Hero 推荐理由行；Sheet 顶部说明         |
| `canUseCuda`         | 为 false 时不显示 CUDA 相关 CTA / Sheet |

**体积展示**：远程 manifest 无 size 字段。本期使用 **静态预估文案**（i18n）：

- `fullEditionSizeHint`: `约 1.4 GB`
- `liteEditionSizeHint`: `约 150 MB`

安装完成后，已安装列表仍显示精确 `formatSize(addon.info.size)`。

---

## 6. 错误与边界场景

| 场景                                   | UI 行为                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| 非 N 卡                                | 无 CUDA CTA；区块 C 仅 Vulkan                                                          |
| N 卡但 `canUseCuda: false`（驱动过旧） | Hero 黄/灰状态 + 原因；Sheet 不可用                                                    |
| 自定义 addon 激活                      | 区块 C 显示自定义；Sheet 仍可下载 CUDA 但不自动切换，下载完成后 toast 提示「是否切换」 |
| 仅 GPU 模式 + 下载中                   | 下载不影响模式；下载完成后后端切换需用户知悉（toast `版本切换成功`）                   |
| 重复点击升级                           | 下载进行中 CTA disabled                                                                |
| Linux                                  | 与 Windows 同 UI；tar/node 命名沿用 `addonDownloader` 现有逻辑                         |

---

## 7. 组件与文件变更（实现指引）

### 7.1 建议拆分

| 文件                      | 职责                               |
| ------------------------- | ---------------------------------- |
| `GpuAccelerationCard.tsx` | 容器：数据加载、四区块编排、进度条 |
| `GpuStatusHero.tsx`       | 区块 A                             |
| `GpuModeSelector.tsx`     | 区块 B（可从现有 inline 抽出）     |
| `GpuBackendSwitcher.tsx`  | 区块 C                             |
| `CudaDownloadSheet.tsx`   | Sheet 全流程                       |
| `GpuInstalledList.tsx`    | 区块 D 已安装管理                  |
| `GpuDiagnosticsPanel.tsx` | 区块 D 检测详情                    |

**原则**：单文件职责清晰，便于后续 Canvas/Storybook 预览 Sheet。

### 7.2 删除/废弃的 UI 行为

- `handleBackendSelect` 内对未安装 variant 调用 `handleDownload` — **删除**。
- 高级选项 `Collapsible` — **替换**为区块 D「更多」。
- 原 `packageTypeHintFull/Lite/Auto` 三段 — **替换**为 Sheet 两卡片 + 一行 auto 说明。

### 7.3 IPC / 主进程

**无需改动**。可选增强（非阻塞）：新 IPC `get-addon-download-estimates` 返回各 variant+type 的远程 HEAD 体积 — 列入 backlog。

### 7.4 i18n 新增 key（`settings.gpuAcceleration.*`）

| Key                    | 用途                                           |
| ---------------------- | ---------------------------------------------- |
| `downloadSheetTitle`   | Sheet 标题                                     |
| `downloadSheetReason`  | 推荐理由标签                                   |
| `selectCudaVersion`    | 版本区标题                                     |
| `selectPackageType`    | 包类型区标题                                   |
| `fullEditionDesc`      | 完整版卡片副文案                               |
| `liteEditionDesc`      | 轻量版卡片副文案                               |
| `fullEditionSizeHint`  | 约 1.4 GB                                      |
| `liteEditionSizeHint`  | 约 150 MB                                      |
| `liteRequiresToolkit`  | 轻量版 disabled 警告                           |
| `startDownload`        | 主按钮                                         |
| `downloadCudaPack`     | 区块 C 次要链                                  |
| `manageInstalled`      | 跳转 D 的锚文本                                |
| `switchMirrorAndRetry` | 失败 toast                                     |
| `moreOptions`          | 区块 D 标题（可复用 `advancedOptions` 改文案） |
| `currentBackend`       | 区块 C 标题                                    |
| `compatibleOldDriver`  | 旧版本 tooltip                                 |

现有 key 大量可复用：`upgradeToCuda` 改为带 edition/size 插值的新模板 `upgradeToCudaWithDetails`。

---

## 8. 验收清单

- [ ] N 卡 + Vulkan 运行：Hero 显示带版本/类型/体积的升级 CTA；点击打开 Sheet；不展开「更多」可完成下载。
- [ ] Sheet 内可改版本、包类型、下载源；默认与 `recommendation` 一致。
- [ ] Toolkit 未安装时轻量版不可下载并有明确说明。
- [ ] 区块 C 切换后端不触发下载；未安装 CUDA 仅显示「下载」链。
- [ ] 下载源仅出现在 Sheet，与开始下载相邻。
- [ ] 下载失败 toast 可一键切换镜像并重试。
- [ ] 已安装列表「更新」打开 Sheet 预填对应版本。
- [ ] macOS 不出现 Sheet / 区块 C CUDA 内容。
- [ ] zh/en 文案完整；无新增 typecheck 错误。

---

## 9. Spec 自检

| 检查项             | 结果                                            |
| ------------------ | ----------------------------------------------- |
| 占位符 TBD         | 无                                              |
| 内部一致性         | Hero / Sheet / recommendation 逻辑对齐          |
| 范围               | 单 Tab UI refactor，不含 IPC 协议变更           |
| 歧义               | 体积用预估文案；精确值仅安装后列表展示 — 已写明 |
| 与用户确认方向一致 | 方案 1 + 四区块 — 是                            |

---

## 10. 后续步骤

1. 用户评审本 spec。
2. 通过后 invoke **writing-plans** 生成 `docs/superpowers/plans/2026-06-13-windows-cuda-acceleration-ui-plan.md`。
3. 按 plan 实施 `GpuAccelerationCard` 重构。
