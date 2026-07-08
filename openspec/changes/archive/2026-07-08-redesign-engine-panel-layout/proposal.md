## Why

云端听写已从最初的 1 种类型（OpenAI 兼容）扩到 8 种（OpenAI 兼容 · ElevenLabs · Deepgram · 豆包 · 腾讯云 · 阿里云 · 讯飞 · Gladia），当初「侧栏单一 cloud 入口 + 面板内按类型分区」的布局（cloud-asr-provider-grouping）已被规模压垮，实测暴露三类问题：

1. **三层嵌套主从过深**：左栏（引擎）→ 面板内左列（8 个类型分区盒子，本身长成了第二根侧栏）→ 实例表单。类型盒子纵向堆叠冗长，且左栏「云端听写」条目的 tags 需要罗列全部服务商，换行溢出、视觉已破版（见截图）。
2. **单例的「实例」概念是纯噪音**：8 类中 7 类是品牌型硬单例（固定服务端、一份凭据）。用户却要先点「配置」_创建实例_、再填表单；删除要 hover 出垃圾桶再二次确认——对单例而言这层实例壳没有任何信息量，只有点击成本。
3. **可见性不足**：OpenAI 兼容的命名预设（OpenAI / Groq / 硅基流动）藏在「添加实例 ▾」下拉里，不点开根本不知道；各云服务商品牌被折叠在一个「云端听写」入口之下，与「让用户一眼看出支持哪些平台」的目标相悖。

## What Changes

- **A — 左栏两组分区，云服务商平级外显（推翻旧 D4）**：左栏改为两个带组标题的分组——「本地引擎」（whisper.cpp 内置 / faster-whisper / 本地多模型聚合 / 本地命令行，行为不变）与「云端听写」（每个 `AsrProviderType` 一个平级入口，数据驱动自 `ASR_PROVIDER_TYPES`）。云入口用紧凑单行样式：品牌图标 + 名称 + 就绪状态点（多实例类型附实例计数），不再有 tags 溢出问题。选中某云服务商 → 右栏直达该服务商配置。**显式推翻** cloud-asr-provider-grouping 的「云端听写保持单一引擎视图」要求（当时 3 种类型、担心侧栏膨胀；现 8 种类型且面板内分区列表实际上已是第二根侧栏，拆平反而消掉一层嵌套；分组标题 + 紧凑行控制住膨胀）。
- **B — 品牌型单例去「实例」壳，表单直显**：选中品牌型服务商（ElevenLabs / Deepgram / 豆包 / 腾讯云 / 阿里云 / 讯飞 / Gladia）右栏**直接渲染凭据表单**——无「配置」按钮、无实例列表、无实例删除操作。填齐必填字段即「已就绪」（沿用 `isAsrProviderConfigured` 口径）；底层仍以单实例落 `store.asrProviders`（首次编辑时惰性物化，**存储结构零改动**）。提供低调的「清除配置」动作（带确认）替代原「删除实例」，用于一键抹除凭据。
- **C — OpenAI 兼容预设外显**：OpenAI 兼容视图保留多实例管理，但把命名预设（OpenAI / Groq / 硅基流动 + 自定义）从下拉菜单提升为**常驻可见的快速添加入口**（带图标按钮/卡片排布），一眼可见可对接哪些厂商；实例列表与逐实例编辑/删除/测试连接保持。
- **D — 视图选中态与深链兼容**：`EngineView` 扩展出 `cloud:<typeId>` 形态；`engineModelSelectedView` localStorage 校验器接受新值，历史遗留 `'cloud'` 值平滑映射到云组首个（优先已配置）服务商，不回落 builtin。写 `'builtin'` 的既有跳转（GPU 徽章 / onboarding / resources 重定向）不受影响。
- **E — 兜底保留**：已存实例的 `type` 若不在当前 `ASR_PROVIDER_TYPES`（类型下线），该孤儿类型仍生成云组入口，实例可查看/删除，不凭空消失（对齐原分组的兜底语义）。
- **非破坏**：后端引擎 id 恒为 `'cloud'`、`ASR_TRANSCRIBER_MAP` 分发、任务页「引擎 ▸ 模型」下拉分组、`store.asrProviders` 数据结构与已存实例**零改动**；纯呈现层（左栏导航 + 云配置面板）重构。

## Capabilities

### New Capabilities

（无——均为既有 `cloud-asr-transcription` 能力的呈现要求变更）

### Modified Capabilities

- `cloud-asr-transcription`：
  - **反转**「云端听写保持单一引擎视图（不拆分左栏）」→ 云服务商类型在左栏「云端听写」分组下平级外显（每类型一入口）；原要求中的非破坏约束（任务页 / 分发 / 存储不变）全部保留。
  - **替换**「配置面板按服务商类型分区」→ 分区职责上移到左栏分组导航；右栏改为「所选服务商专属面板」（单例=表单直显；多实例=预设快速添加 + 实例列表 + 表单）。
  - **修改**「服务商类型基数（协议型多实例 / 品牌型硬单例）」→ 品牌型不再有「配置」入口与实例删除，改为表单直显 + 惰性物化 + 「清除配置」。
  - **修改**「Protocol-type provider presets」→ 预设由「添加实例下拉菜单」改为常驻可见的快速添加入口。
  - **修改**「云端听写类别呈现全部服务商类型」→ 呈现载体由「单入口的 subtitle/tags 罗列」改为「分组下逐服务商平级入口」，类型清单事实源仍为 `ASR_PROVIDER_TYPES`。

## Impact

- **UI（主要）**：`renderer/components/resources/EngineModelTab.tsx`（左栏分组导航、`EngineView` 扩展、云状态点/徽标口径、`asrProviders` 状态上提为单一事实源）；`renderer/components/resources/engines/panels/CloudAsrPanel.tsx` 重构为按类型的 `CloudProviderPanel`（单例表单直显 / 多实例管理两种形态，复用现有字段渲染、标签式模型录入、测试连接逻辑）。
- **纯逻辑**：`types/asrProvider.ts` 或 `renderer/lib` 新增纯函数（云视图清单构建、legacy `'cloud'` 选中态映射、单例实例解析），供 `scripts/test-engine-units.ts` 单测；`groupInstancesByType` 保留（孤儿兜底与按类型切片仍用）。
- **i18n**：`renderer/public/locales/{zh,en}/resources.json`——新增组标题（本地引擎/云端听写）、「清除配置」、快速添加等 key；收敛 `engines.cloud.*` 中为单入口 tags/subtitle 服务的文案；`npm run check:i18n` 守卫。
- **不改**：`main/service/asr/*`、`ASR_TRANSCRIBER_MAP`、`renderer/lib/engineModels.ts` 的分组/编码、`renderer/components/Models.tsx`、`main/helpers/store`（asrProviders 结构）、各服务商字段定义（`fields`）。
- **文档**：README（zh/en）云端听写小节的入口描述与截图后续人工更新。
