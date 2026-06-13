# B15 技术债批次设计与决策记录

> 日期：2026-06-12 · 分支 `feat/resource-hub` · 上游：`docs/superpowers/specs/2026-06-12-remaining-roadmap-design.md` §5
>
> **无人值守模式**：代理按项目实际选取方案，本文档供事后评审。

## 探索期复核结论

| roadmap 项                      | 复核结果                                                                                                              | 处理                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| webSecurity 迁移需新建 protocol | **media:// 已在 B7 前后接入**（VideoPlayer/VideoPreview + registerFileProtocol）；字幕轨用 blob URL，无 file:// 残留  | 本批只需 `registerSchemesAsPrivileged` + 开启 `webSecurity: true` |
| dev gpuName 混排                | cudaUtils 模拟路径已设 `gpuName`，但 `detectGpus()` 仍读真机 Apple GPU，`GpuAccelerationCard` 优先展示 `gpus[0].name` | 模拟 CUDA 时 `detectGpus` 返回模拟卡                              |
| Windows 路径                    | 主进程已用 `path.*`；renderer 校对链 proofreadUtils/ProofreadImport/ProofreadFileList/FileSelector 仍 `split('/')`    | 统一改 `path.basename/dirname`                                    |

## 决策记录

### 决策 #1：webSecurity 开启方式

**问题**：`webSecurity: false` 是为加载本地媒体；现已有 `media://` 自定义协议，继续关闭 webSecurity 无必要且降低安全性。

**采用方案**：

1. 在 `app.whenReady()` 之前调用 `protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true, corsEnabled: true } }])`；
2. 默认 `webSecurity: true`；
3. 回退开关：环境变量 `SMARTSUB_LEGACY_WEB_SECURITY=true` 时恢复 `webSecurity: false`（与 roadmap「保留回退开关」一致）。

**备选**：迁移到 `protocol.handle`——registerFileProtocol 已稳定运行，无功能增益，弃。

### 决策 #2：Windows 路径修复范围

**问题**：校对导入链用手写 `split('/')` 取文件名/目录，Windows 反斜杠路径会截错。

**采用方案**：仅改 renderer 校对/合成相关 4 文件（proofreadUtils、ProofreadImport、ProofreadFileList、FileSelector），与 main 侧已用 `path` 的做法对齐；不新增 pathUtils 抽象层（YAGNI）。

**备选**：IPC 层统一 normalize——改动面大，本批只修用户可见断点，弃。

### 决策 #3：dev 模拟 GPU 名称一致性

**问题**：`DEV_SIMULATE_CUDA=true` 时驱动/CUDA 版本为模拟值，显卡名却显示真机「Apple M1 Pro」，截图/调试误导。

**采用方案**：`detectGpus()` 在 `getDevSimulationConfig()?.enabled` 时返回 `[{ name: simConfig.gpuName, vendor: 'nvidia' }]`，与 `getGpuCudaSupport()` 模拟数据同源。

**备选**：仅改 GpuAccelerationCard 展示优先级——其它消费 `gpus` 的 UI 仍混排，弃。

## 验收标准

1. 默认 `webSecurity: true`，校对播放/合成预览/拖拽导入/模型管理路径无回归；`SMARTSUB_LEGACY_WEB_SECURITY=true` 可回退；
2. Windows 路径下校对导入文件名与目录扫描正确（用户 Windows 实机冒烟）；
3. `DEV_SIMULATE_CUDA=true` 时 GPU 名称与驱动信息均为模拟值；
4. 三项门禁全绿。

## 实机冒烟清单（B15 合并前）

- [ ] 校对页：选含视频+字幕的 Windows 路径工程，播放+字幕轨显示
- [ ] 合成页：预览视频
- [ ] 启动台/任务页：拖拽导入媒体
- [ ] 资源中心：模型下载/列表
- [ ] 设置页：`DEV_SIMULATE_CUDA=true yarn dev` 显卡名与驱动一致为模拟
