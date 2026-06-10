# SmartSub GPU 加速体验升级实施方案（Vulkan 接入）

> 状态：已评审通过，进入实施（实施决策见附录 C）
> 日期：2026-06-10
> 关联：whisper.cpp builder 分支已新增 Vulkan 构建产物（`addon-windows-vulkan.node.gz` / `addon-linux-vulkan.node.gz`，约 17MB），`addon-versions.json` 已包含 `"vulkan"` 键

---

## 1. 背景与目标

### 1.1 现状痛点（按用户反馈频率排序）

| #   | 痛点                                                                    | 受影响人群                 | 根因                                  |
| --- | ----------------------------------------------------------------------- | -------------------------- | ------------------------------------- |
| 1   | AMD 显卡 / Intel 核显用户完全没有 GPU 加速，只能用 CPU 慢速转写         | 约 30%~40% 的 Windows 用户 | 此前只有 CUDA 加速包，仅支持 NVIDIA   |
| 2   | N 卡用户面对「4 个 CUDA 版本 × 完整版/精简版」共 8 种组合，不知道选哪个 | 所有想用加速的 N 卡用户    | 选择项暴露了实现细节（CUDA 版本矩阵） |
| 3   | 国内用户从 GitHub 下载加速包经常失败/极慢                               | 国内大部分用户             | 加速包 150~220MB 且依赖 GitHub CDN    |
| 4   | 下载了 CUDA 包却加载失败/转写崩溃（驱动不匹配、缺 DLL 等）              | 部分 N 卡用户              | CUDA 版本与驱动强耦合；错误信息不友好 |
| 5   | 表面开启了"CUDA 加速"，实际静默回退到 CPU，用户不知情，只觉得"很慢"     | 部分用户                   | 回退逻辑无任何 UI 反馈                |

### 1.2 Vulkan 带来的机会

- **单一产物全厂商通用**：NVIDIA / AMD / Intel（含核显）一个文件全覆盖，无版本矩阵
- **体积小**：约 17MB（gz），是 CUDA 包的 1/9，可直接预置进安装包
- **无运行时依赖**：只需要显卡驱动自带的 `vulkan-1.dll` / `libvulkan.so.1`，无需 CUDA Toolkit、无需附带 DLL
- **失败安全**（已源码级确认）：ggml 的 Vulkan 后端注册全量 try/catch，无可用 GPU 时自动回退同文件内的 CPU 后端，不会闪退
- **性能**：N 卡上约为 CUDA 的 70%~90%；A 卡/核显从纯 CPU 变 GPU，通常 3~10 倍提升

### 1.3 目标

1. **零思考开箱即用**：安装完成后，绝大多数用户无需进设置页即获得 GPU 加速
2. **选择压力降级**：把"必须做的选择"变成"可选的优化"；隐藏实现细节（CUDA 版本、完整/精简）到高级区
3. **任何机器都能跑**：建立完整降级链，杜绝因加速导致的"无法转写"
4. **状态透明**：用户随时知道当前用的是什么加速方式、为什么

---

## 2. 方案总览

```
                       ┌─────────────────────────────────────────┐
                       │ 安装包预置（Windows / Linux）           │
                       │  addon.vulkan.node (~50MB，装机即有)    │
                       │  addon.node        (CPU, ~3MB，保底)    │
                       │  macOS 维持现状（Metal / CoreML 内置）  │
                       └─────────────────────────────────────────┘
                                          │
            ┌─────────────────────────────┼──────────────────────────────┐
            ▼                             ▼                              ▼
   N 卡用户                      A 卡 / 核显用户                 无 GPU / 虚拟机
   默认 Vulkan 直接加速          默认 Vulkan 直接加速            Vulkan 加载失败
   设置页提示可升级 CUDA         （此前只能 CPU）                → 自动落 CPU
   （按需下载，进阶选项）                                        （无感知，不闪退）
```

**核心变化一句话：从「用户选择加速包」变成「默认就有加速，CUDA 是 N 卡用户的进阶选项」。**

---

## 3. 用户体验设计（核心章节）

### 3.1 设计原则

1. **默认正确**：自动模式覆盖 95% 用户；不强迫任何人理解 CUDA / Vulkan 是什么
2. **一个主操作**：设置页任何时刻最多出现一个主按钮（启用 / 升级 / 修复）
3. **降级必告知**：每次实际后端与期望不符时，用一条 toast + 状态卡说明，绝不静默
4. **失败给出路**：每种失败场景都有人话解释 + 可操作建议（如"更新显卡驱动"带链接）
5. **进阶不打扰**：CUDA 版本、完整/精简、自定义 addon、下载源全部收进「高级选项」折叠区

### 3.2 五类典型用户旅程

#### 旅程 A：AMD 显卡新用户（最大受益者）

1. 安装 → 首次启动，后台静默检测：发现 AMD GPU + `vulkan-1.dll` 存在
2. 直接拖入视频转写 → **自动以 Vulkan GPU 加速运行**，转写卡片显示 `GPU 加速 · Vulkan` 徽章
3. 全程零配置、零下载、零等待

#### 旅程 B：NVIDIA 显卡新用户

1. 安装 → 默认 Vulkan 加速立即可用（同旅程 A）
2. 进设置页时看到一条不打扰的升级建议卡：
   > 检测到 NVIDIA GeForce RTX 3080。当前使用 Vulkan 加速，升级到 CUDA 加速包可再提升约 10%~30% 性能。
   > 【升级到 CUDA（推荐 12.4，约 151MB）】
3. 点一下 → 自动选版本、自动选精简/完整、下载、校验、启用，完成后徽章变为 `GPU 加速 · CUDA 12.4`
4. 不升级也完全可用——CUDA 从"必须搞懂的前置门槛"变成"可选的锦上添花"

#### 旅程 C：老用户（已配置 CUDA）升级新版本

1. 升级后一切不变：继续加载其已下载的 CUDA 包，徽章显示 `GPU 加速 · CUDA`
2. 唯一变化：若某天 CUDA 包加载失败（如驱动更新后不兼容），不再直接掉到 CPU，而是**先自动落到内置 Vulkan**，并 toast 告知

#### 旅程 D：无独显的虚拟机 / 极老机器用户

1. 首次转写时 Vulkan addon `dlopen` 失败（无 `vulkan-1.dll`）→ **自动加载 CPU 版**，转写正常完成
2. 转写卡片显示 `CPU 模式`；设置页状态卡说明原因：
   > 未检测到可用的 GPU 环境（缺少 Vulkan 运行库），已使用 CPU 模式。若本机有独立显卡，请尝试更新显卡驱动。
3. 全程不闪退、不报错弹窗、不阻断任务

#### 旅程 E：国内网络不佳的 N 卡用户

1. 默认 Vulkan 开箱即用（预置，无需下载）→ 已经有 GPU 加速兜底
2. 想升级 CUDA 时下载失败 → toast 提示并建议切换镜像源（ghproxy），**失败不影响当前 Vulkan 加速**
3. 对比旧版：下载失败 = 完全没有加速；新版：下载失败 = 维持 Vulkan，体验底线大幅抬高

### 3.3 设置页 UI 设计（`GpuAccelerationCard` 重构）

```
┌─ GPU 加速 ────────────────────────────────────────────────┐
│                                                            │
│  ● 当前状态卡（始终可见）                                  │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 🟢 GPU 加速运行中 · Vulkan                            │ │
│  │ NVIDIA GeForce RTX 3080 · 驱动 572.16                 │ │
│  │ ──────────────────────────────────────────────       │ │
│  │ 💡 升级到 CUDA 加速包可再提升约 10%~30% 性能          │ │
│  │ [ 升级到 CUDA 12.4（精简版 · 151MB）]   ← 唯一主按钮  │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  加速模式（Segmented Control）                             │
│  [ 自动（推荐） | 仅 GPU | 仅 CPU ]                        │
│                                                            │
│  ▸ 高级选项（默认折叠）                                    │
│    ├─ 加速后端：分组下拉                                   │
│    │    通用 GPU（NVIDIA / AMD / Intel）                   │
│    │      └─ Vulkan（内置）            [当前] [适用]       │
│    │    NVIDIA CUDA（性能最佳，仅 N 卡）                   │
│    │      ├─ 13.0.2                    [适用]              │
│    │      ├─ 12.4.0                    [推荐]              │
│    │      ├─ 12.2.0 / 11.8.0           [兼容旧驱动]        │
│    │      └─（A 卡/核显环境下整组置灰 + tooltip 说明）     │
│    ├─ CUDA 包类型：精简版 / 完整版（仅选中 CUDA 时显示）   │
│    ├─ 下载源：GitHub / ghproxy 镜像                        │
│    ├─ 自定义 addon 路径（保留现有功能）                    │
│    └─ 已安装管理：列表（含内置项）· 删除 · 检查更新        │
│                                                            │
│  ▸ 检测详情（默认折叠，诊断用）                            │
│     GPU：NVIDIA GeForce RTX 3080（nvidia-smi ✓）           │
│     Vulkan 运行库：System32\vulkan-1.dll ✓                 │
│     CUDA 驱动支持：12.7（≥ 11.8 ✓）  CUDA Toolkit：未安装  │
│     上次加载：Vulkan · 成功 · 2026-06-10 10:32             │
│     [ 复制诊断信息 ]                                       │
└────────────────────────────────────────────────────────────┘
```

**状态卡的五种状态与颜色语义：**

| 状态                           | 颜色  | 标题文案（zh）                | 主按钮                       |
| ------------------------------ | ----- | ----------------------------- | ---------------------------- |
| CUDA 加速运行中                | 🟢 绿 | `GPU 加速运行中 · CUDA {ver}` | 无（已是最优）               |
| Vulkan 加速运行中（N 卡）      | 🟢 绿 | `GPU 加速运行中 · Vulkan`     | 「升级到 CUDA」              |
| Vulkan 加速运行中（A 卡/核显） | 🟢 绿 | `GPU 加速运行中 · Vulkan`     | 无（已是该硬件最优）         |
| 发生过降级                     | 🟡 黄 | `已自动切换到 {实际后端}`     | 「查看原因」展开详情         |
| CPU 模式                       | ⚪ 灰 | `CPU 模式`                    | 视检测结果给「修复建议」或无 |
| 用户主动选了仅 CPU             | ⚪ 灰 | `CPU 模式（手动设置）`        | 无                           |

**关键交互细节：**

- 「加速模式」三态开关取代现有的 `useCuda` 布尔开关：
  - **自动（推荐，默认）**：App 按降级链自己选，永远能跑
  - **仅 GPU**：强制 GPU，全部 GPU 后端失败时报错而非静默回 CPU（给"宁可报错也要快"的用户）
  - **仅 CPU**：彻底关闭 GPU（兼容现有 `useCuda=false` 的语义）
- 「升级到 CUDA」按钮点击后全自动：按驱动选版本（现有 `getRecommendedAddonVersion` 逻辑）→ 按是否装 Toolkit 选精简/完整 → 下载（带进度）→ 校验 → 启用 → 状态卡刷新。用户全程只点了一下
- 下载失败的 toast 带「切换镜像源重试」按钮，一键切 ghproxy 重试
- 已安装列表中内置项标注 `内置`，不可删除；下载到 userData 的项可删除

### 3.4 转写过程中的状态反馈

- 任务卡片 / 任务列表头部增加当前后端小徽章：`CUDA 12.4` / `Vulkan` / `CPU` / `Metal` / `CoreML`
- 数据来源：`loadWhisperAddon` 返回实际加载结果（后端类型 + 来源路径），通过 IPC 推给渲染层
- **降级发生时**（期望 GPU、实际 CPU 等）：
  - toast（一次性，不重复打扰）：`GPU 加速暂不可用，已自动切换到 CPU 模式继续转写`，附「查看原因」
  - 设置页状态卡同步变黄，展示具体原因与建议
- 转写完成的统计信息中附后端标识，方便用户对比加速效果（如 `用时 2 分 31 秒 · Vulkan`）

### 3.5 失败诊断文案表（全部场景穷举）

| 场景                      | 检测依据                                                  | 用户看到的解释（zh）                         | 给出的行动建议                                                           |
| ------------------------- | --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| 缺 Vulkan 运行库          | dlopen 报 `vulkan-1.dll` 缺失 / Linux 缺 `libvulkan.so.1` | 未检测到 Vulkan 运行环境                     | 「更新显卡驱动」（链接到 N/A/I 官方驱动页）；Linux 提示安装 `libvulkan1` |
| 驱动太老（Vulkan < 1.2）  | addon 加载成功但枚举不到设备 + 日志含版本错误             | 显卡驱动版本过旧，无法启用 GPU 加速          | 「更新显卡驱动」                                                         |
| 有 N 卡但 CUDA 包加载失败 | dlopen 异常 / 缺 cudart DLL                               | CUDA 加速包与当前环境不兼容，已回退到 Vulkan | 「重新下载完整版」或「改用 Vulkan（当前）」                              |
| 下载失败 / 校验失败       | 网络错误 / checksum 不匹配                                | 加速包下载失败                               | 「切换镜像源重试」/「稍后再试」；强调当前 Vulkan 不受影响                |
| 远程桌面 / 无显示会话     | 加载成功但无设备                                          | 当前会话无可用 GPU（远程桌面等场景常见）     | 说明本地登录后可恢复                                                     |
| 用户自定义 addon 加载失败 | customPath dlopen 异常                                    | 自定义 addon 加载失败，已回退到内置版本      | 「检查文件」/「清除自定义路径」                                          |

---

## 4. 行为规范（决策表）

### 4.1 后端推荐矩阵（`auto` 模式下的决策顺序）

| 优先级 | 条件                                        | 选择                                                                   |
| ------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| 1      | 设置了 customAddonPath 且文件存在           | 自定义 addon（完全尊重用户）                                           |
| 2      | userData 已安装 CUDA 包，且 NVIDIA 驱动可用 | CUDA（用户此前的明确选择 / 升级结果）                                  |
| 3      | userData 已安装更新版 Vulkan 包             | 下载的 Vulkan（比内置新）                                              |
| 4      | 内置 Vulkan 存在                            | 内置 Vulkan                                                            |
| 5      | 以上全部失败                                | 内置 CPU                                                               |
| -      | macOS                                       | 维持现状：Apple Silicon + encoder 模型 → CoreML，否则 Metal/CPU 内置版 |

### 4.2 加载降级链（每一级 dlopen 都包 try/catch）

```
custom → userData CUDA → userData Vulkan → 内置 Vulkan → 内置 CPU
```

- 每级失败：记录 `{ 后端, 路径, 错误, 时间 }` 到加载历史（最近 10 条，诊断面板展示）
- 第一次降级发出 toast；同一原因的重复降级在同一会话内不重复打扰
- `仅 GPU` 模式：链条止于内置 Vulkan，失败则任务报错（明确文案 + 引导去设置页）
- `仅 CPU` 模式：直接加载内置 CPU
- **加载结果缓存**：成功加载的后端在本会话内复用，不重复探测

### 4.3 默认值与迁移

| 用户                                                 | 迁移规则                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 新安装                                               | `gpuMode = 'auto'`，开箱即用                                                                 |
| 老用户 `useCuda = true`                              | → `'auto'`（已装 CUDA 包者命中矩阵优先级 2，行为不变）                                       |
| 老用户 `useCuda = false`（默认值，绝大多数从未动过） | → `'auto'` + 首次启动一次性通知：「新版本已支持通用 GPU 加速并为你自动启用，可在设置中关闭」 |
| 老用户曾在新版主动选过 `仅 CPU`                      | 永久尊重，不再迁移                                                                           |

> 迁移为 `auto` 的理由：行为只会变快不会变坏（有完整降级链），且 A 卡/核显老用户是 Vulkan 最大受益群体；通过一次性通知保证知情权。

---

## 5. 技术实施（分阶段）

### Phase 0：打包与分发链路（前置，0.5 天）

**改动文件：`.github/workflows/release.yml`**

- Windows / Linux 两个 matrix 项各加一个 `vulkan_addon_name` 字段（`addon-windows-vulkan.node.gz` / `addon-linux-vulkan.node.gz`）
- 「Download addon」步骤追加下载该 gz；「Prepare」步骤 `gunzip` 后放入 `extraResources/addons/addon.vulkan.node`
- macOS matrix 不变
- `electron-builder.yml` **零改动**（`addons/` 目录通配规则自动包含新文件）
- 安装包体积影响：Windows NSIS / Linux AppImage 约 +17~20MB

### Phase 1：检测层（1 天）

**改动文件：`main/helpers/cudaUtils.ts`（扩展，不重命名以减小 diff）、`types/addon.ts`**

新增能力：

```ts
// types/addon.ts 新增
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown';
export type AddonVariant = CudaVersion | 'vulkan'; // 贯穿下载/安装/选择全链路
export type GpuMode = 'auto' | 'gpu-only' | 'cpu-only'; // 取代 useCuda

export interface GpuEnvironment {
  gpus: { name: string; vendor: GpuVendor }[]; // Win: Win32_VideoController；Linux: lspci
  vulkanRuntime: boolean; // Win: System32\vulkan-1.dll 存在性；Linux: ldconfig 查 libvulkan.so.1
  nvidia: CudaEnvironment | null; // 复用现有检测链（nvcc + nvidia-smi）
  recommendation: BackendRecommendation; // 按 4.1 矩阵生成
}
```

要点：

- Vulkan 探测只做**文件存在性检查**（毫秒级、无子进程），不调用 `vulkaninfo`
- 显卡厂商枚举：Windows 用 `Get-CimInstance Win32_VideoController`（PowerShell，一次调用拿全部 GPU 名），Linux 用 `lspci | grep -i vga`，均带 try/catch 与超时
- 现有 `getCudaEnvironment()` 保留并被 `getGpuEnvironment()` 包含；现有 IPC `get-cuda-environment` 保留（兼容），新增 `get-gpu-environment`
- 开发模拟扩展：`DEV_SIMULATE_GPU_VENDOR`、`DEV_SIMULATE_VULKAN=false` 等环境变量

### Phase 2：下载与安装管理（1 天）

**改动文件：`main/helpers/addonDownloader.ts`、`addonVersions.ts`、`addonManager.ts`、`types/addon.ts`**

- `getAddonFileName` 增加 vulkan 分支：`addon-{windows|linux}-vulkan.node.gz`（仅 `node.gz`，无 `tar.gz`）
- `RemoteAddonVersions` 键类型放宽为 `AddonVariant`；`"vulkan"` 键的 checksum 仅含 `windows-node` / `linux-node`（CI 已发布该结构）
- 安装目录沿用现有规则：`userData/addons/vulkan/addon.node`
- 更新检测：vulkan 与 CUDA 版本同等参与「检查更新」；内置版本号取 App 打包时间戳，远程更新允许覆盖安装到 userData（优先级高于内置，见 4.1）
- 断点续传、校验、进度上报复用现有实现，无需新代码路径

### Phase 3：加载降级链（1 天，核心）

**改动文件：`main/helpers/whisper.ts`、新增 `main/helpers/addonLoader.ts`（建议抽出）**

- 现状：`loadWhisperAddon` 单路径决策 + **裸 `process.dlopen`（无 try/catch）**——这是必须修的点
- 重构为：按 4.1 矩阵生成候选列表 → 逐个 `tryLoad(path)`（每个包 try/catch + `setupLibraryPath`）→ 返回 `{ whisperFn, backend, source, fallbackInfo }`
- 加载历史环形缓冲（10 条）+ 最近一次结果持久化（诊断面板与状态卡数据源）
- 新增 IPC：`get-active-backend`（渲染层徽章）、降级事件推送（toast）
- `gpu-only` / `cpu-only` 模式裁剪候选列表
- 性能：成功结果会话级缓存；候选探测只发生在首次转写或设置变更后

### Phase 4：UI 重构（1.5~2 天）

**改动文件：`renderer/components/settings/GpuAccelerationCard.tsx`（重构）、任务卡片组件（加徽章）、`renderer/public/locales/{zh,en}/settings.json`**

- 按 3.3 结构重排：状态卡（含唯一主按钮）→ 三态模式开关 → 高级折叠区 → 检测详情折叠区
- 「升级到 CUDA」一键流程复用现有下载进度组件
- 后端下拉分组渲染 + 不适用项置灰 + tooltip
- 任务页徽章 + 降级 toast（监听 Phase 3 事件）
- i18n：新增约 30 个 key，中英双语（文案见 3.3 / 3.5 表）

### 阶段依赖与总工作量

```
Phase 0（打包）──┐
Phase 1（检测）──┼──> Phase 3（加载链）──> Phase 4（UI）──> 测试验收
Phase 2（下载）──┘
```

总计约 **5~6 人天**（含测试矩阵执行 1 天）。Phase 0/1/2 可并行。

---

## 6. 兼容与迁移细节

| 关注点                                  | 处理                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| 旧版 App + 新 `addon-versions.json`     | 旧版按 CUDA 版本键查找，自动忽略 `"vulkan"` 键——已验证向后兼容                    |
| 新版 App + 旧 release（无 vulkan 产物） | 远程无 `"vulkan"` 键时隐藏"检查 Vulkan 更新"，内置版仍可用                        |
| `settings.useCuda`                      | 读取旧值做一次性迁移（见 4.3），新键 `settings.gpuMode`；旧键保留不删（回滚安全） |
| `selectedVersion` 存储                  | 类型从 `CudaVersion` 放宽为 `AddonVariant`，旧值天然合法                          |
| customAddonPath                         | 行为不变，仍为最高优先级                                                          |
| macOS                                   | 全链路不变（Metal/CoreML 已内置且体验良好），仅状态卡补充显示当前后端徽章         |

---

## 7. 边界场景与风险

| 场景                                   | 行为                                                       | 风险评估                               |
| -------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| 无 `vulkan-1.dll`（无驱动 VM、Server） | dlopen 抛可捕获异常 → 落 CPU                               | 已设计兜底，无风险                     |
| 驱动有 dll 但 Vulkan < 1.2 / 无设备    | ggml 注册函数 try/catch 返回 nullptr → 同文件 CPU 后端接管 | 上游源码已确认，无闪退风险             |
| 远程桌面（RDP）会话                    | 可能枚举不到 GPU → CPU，诊断文案专门覆盖                   | 体验降级但可解释                       |
| 双显卡笔记本（核显+独显）              | whisper 默认取第一个 GPU 设备；绝大多数场景正确            | 低风险；后续可加设备选择（非本期）     |
| 首次转写 shader 编译延迟（数秒）       | 驱动会缓存，仅首次                                         | 可在首次启用时提示"首次启动稍慢属正常" |
| Vulkan 性能低于预期的个别驱动          | 用户可在高级区切回 CPU 或升级 CUDA                         | 提供逃生通道即可                       |
| 预置包随 App 发版老化                  | 更新检测允许下载新版 Vulkan 到 userData 覆盖内置           | 已设计                                 |

---

## 8. 测试矩阵与验收标准

### 8.1 环境矩阵（必测）

| 平台    | 环境                                 | 期望结果                                |
| ------- | ------------------------------------ | --------------------------------------- |
| Windows | NVIDIA（新驱动）                     | auto → Vulkan 成功；升级 CUDA 后 → CUDA |
| Windows | NVIDIA（驱动 < Vulkan 1.2 的老机器） | 落 CPU + 黄色状态卡 + 建议更新驱动      |
| Windows | AMD 独显                             | auto → Vulkan 成功；CUDA 组置灰         |
| Windows | Intel 核显（无独显轻薄本）           | auto → Vulkan 成功                      |
| Windows | Hyper-V / 无 GPU 驱动虚拟机          | dlopen 失败 → CPU，无弹窗无闪退         |
| Windows | RDP 远程会话                         | CPU + 对应诊断文案                      |
| Linux   | NVIDIA 闭源驱动 / AMD mesa           | auto → Vulkan 成功                      |
| Linux   | 无 `libvulkan1` 的服务器             | 落 CPU + 提示安装命令                   |
| macOS   | Intel / Apple Silicon                | 回归测试：行为与现版本完全一致          |

### 8.2 验收标准

1. **稳定性**：上表任一环境均能完成转写，零闪退、零阻断性报错弹窗
2. **正确性**：状态卡显示的后端 = 实际 dlopen 成功的后端（以日志核对）
3. **透明性**：每次降级均有 toast + 状态卡黄色态 + 可查看的原因
4. **零配置率**：新装用户不进设置页即可获得其硬件下的最优可用加速
5. **回归**：现有 CUDA 用户升级后行为不变；自定义 addon、下载断点续传、镜像源功能不受影响

---

## 9. 发布策略

1. **Beta 渠道先行**（项目已配置 `generateUpdatesFilesForAllChannels`）：先发 beta 收集一周反馈
2. **日志埋点**：加载链每级结果写入现有日志体系（`logMessage`），重点观察 Vulkan dlopen 成功率与降级原因分布；诊断面板的「复制诊断信息」降低 issue 沟通成本
3. **文档与 Changelog**：发布说明重点面向 A 卡/核显用户（"你们现在有 GPU 加速了"），N 卡用户说明 CUDA 仍是性能上限选项
4. **回滚预案**：所有新行为收敛在 `gpuMode` 之后；紧急情况下可发补丁把默认值改回 `cpu-only` 等价行为，预置文件无需撤回

---

## 附录 A：上游产物对照表

| 产物（whisper.cpp latest release）                                  | 用途                                      | 体积      |
| ------------------------------------------------------------------- | ----------------------------------------- | --------- |
| `addon-windows-vulkan.node.gz`                                      | Windows 通用 GPU 包（预置 + 可更新）      | ~20MB     |
| `addon-linux-vulkan.node.gz`                                        | Linux 通用 GPU 包（预置 + 可更新）        | ~17.4MB   |
| `addon-windows-cuda-{1180,1220,1240,1302}-optimized.node.gz`        | N 卡进阶包（精简，需 CUDA Toolkit）       | 150~225MB |
| `windows-cuda-*-optimized.tar.gz` / `linux-cuda-*-optimized.tar.gz` | N 卡进阶包（完整，含运行时库）            | 200MB+    |
| `addon-{windows,linux,macos}-x64.node` 等                           | CPU / Metal / CoreML 基础包（打包时预置） | 1~3MB     |
| `addon-versions.json`                                               | 版本与校验和清单（已含 `"vulkan"` 键）    | <1KB      |

## 附录 B：涉及文件清单（App 仓库）

```
.github/workflows/release.yml          Phase 0  预置 Vulkan addon
types/addon.ts                         Phase 1/2  AddonVariant / GpuMode / GpuEnvironment
main/helpers/cudaUtils.ts              Phase 1  厂商 + Vulkan 运行库检测、推荐矩阵
main/helpers/addonDownloader.ts        Phase 2  vulkan 文件名分支
main/helpers/addonVersions.ts          Phase 2  vulkan 键解析与更新检测
main/helpers/addonManager.ts           Phase 2  vulkan 安装目录管理
main/helpers/whisper.ts                Phase 3  降级链重构（修复裸 dlopen）
main/helpers/addonLoader.ts (新增)     Phase 3  候选生成 + tryLoad + 加载历史
main/helpers/ipcAddonHandlers.ts       Phase 1/3  新 IPC（get-gpu-environment / get-active-backend / 降级事件）
renderer/components/settings/GpuAccelerationCard.tsx   Phase 4  UI 重构
renderer/components/（任务卡片组件）    Phase 4  后端徽章 + 降级 toast
renderer/public/locales/{zh,en}/settings.json          Phase 4  新增文案
```

## 附录 C：实施决策记录（2026-06-10 评审确认）

### C.1 已确认事项

| #   | 事项       | 决策                                                                                                                           |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 实施范围   | 一次性完成 Phase 0~4 全部内容（含 UI 重构），按 8.2 验收                                                                       |
| 2   | 老用户迁移 | 所有老用户（含主动设置 `useCuda=false` 者）统一迁移为 `gpuMode='auto'`，首次启动一次性通知，可在设置中改回                     |
| 3   | 开发方式   | 新建 `feat/vulkan-gpu` 分支开发；工作区现存无关改动（release.yml 的 workflow_dispatch、二进制 addon 本地产物等）不纳入本次提交 |

> 注：原 4.3 节假设 `useCuda` 默认值为 false，与代码不符（`main/helpers/store/index.ts` 中默认为 true）。迁移规则按本附录第 2 条执行：不区分 true/false，统一迁移为 `'auto'`；仅在新版中主动选择「仅 CPU」的用户被永久尊重（迁移只在 `gpuMode` 不存在时执行一次）。

### C.2 实施级设计决策（对原方案的细化与偏差）

1. **GPU 厂商枚举改用 `systeminformation` 库**（替代原方案的 PowerShell `Win32_VideoController` / `lspci` 文本解析）。理由：已是项目依赖（^5.27.7）、`si.graphics()` 跨平台返回 vendor/model、规避中文 Windows WMI 编码与精简发行版缺 pciutils 等解析坑。带 try/catch + 超时，结果会话级缓存。Vulkan 运行库检测仍按原方案：Win 查 `System32\vulkan-1.dll`，Linux 查常见路径 + `ldconfig -p` 兜底。

2. **加载链集中化**：新增 `main/helpers/addonLoader.ts`，`resolveCandidates(gpuMode)` 按 4.1 矩阵生成候选 → 逐个 try/catch `dlopen`。`loadWhisperAddon` 签名变更：移除 `canUseCuda` 参数（其检测职责移入 loader 内部并缓存），返回 `{ whisperAsync, backend, variant, source, fallback }`。`subtitleGenerator.ts` 中 `use_gpu = backend !== 'cpu'`（由实际加载结果推导，custom 视为 GPU）。全仓唯一调用点在 `subtitleGenerator.ts`，影响面可控。同时修复现状 bug：非 NVIDIA 环境下自定义 addon 路径被忽略（新矩阵中 custom 无条件最高优先级）。

3. **加载结果与历史**：用现有 electron-store 持久化 `lastAddonLoadResult` + 最近 10 条加载历史（诊断面板数据源）。新增 IPC：`get-gpu-environment`、`get-active-backend`、`addon-fallback` 推送事件（同一原因会话内只 toast 一次）。现有 `get-cuda-environment` IPC 保留兼容。

4. **类型与字段**：`AddonVariant = CudaVersion | 'vulkan'`；`DownloadConfig` / `DownloadState` 的 `cudaVersion` 字段改名 `variant`（主进程 + 渲染层原子改名；读取旧 `addon-download-state.json` 时做字段兼容映射）。安装目录 `userData/addons/vulkan/addon.node`。`RemoteAddonVersions` 键放宽为 `AddonVariant`，`vulkan` 键 checksum 仅含 `windows-node` / `linux-node`（已验证上游 addon-versions.json 结构一致）。

5. **`.gitignore` 增加 `extraResources/addons/addon.vulkan.node`**：该文件仅由 CI 下载生成进安装包，不入库；macOS 本地开发不存在该文件，加载链自然跳过。

6. **macOS 不显示「加速模式」三态开关**（gpuMode 仅对 win/linux 生效），维持 Metal/CoreML 现状，状态卡仅展示当前后端徽章。

7. **迁移实现**：主进程启动时若 `settings.gpuMode` 不存在 → 写入 `'auto'` + `gpuMigrationNotified=false`；渲染层检测到该标记后展示一次性通知并置 true。旧键 `useCuda` 保留不删（回滚安全）。

8. **内置 Vulkan 版本号**：取 `package.json` 的 `buildInfo.buildDate`（CI 注入），用于与远程 `vulkan` 版本比较、提示「下载更新版到 userData 覆盖内置」；开发环境无 buildInfo 时跳过更新提示。

9. **转写完成统计附后端标识**（3.4 节）：仅当现有任务 UI 已展示用时统计时附加，否则本期跳过（YAGNI）。任务页头部徽章与降级 toast 按原方案实施。

10. **测试与验收**：项目无单测框架，不新引入；以 `yarn build` 类型检查通过 + 8.1 手动环境矩阵验收。
