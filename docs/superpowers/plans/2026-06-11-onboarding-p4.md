# P4 新手引导实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。

**Goal:** 首启 3 步向导（随时可跳过）+ 顶栏「？」帮助菜单（重开引导 / 查看日志 / GitHub）。

**上游设计:** 蓝图 §8、§11.2；线框 `resources-onboarding.html` ②。

## 代码事实

- `setSettings` 为合并语义（`{...pre, ...new}`）→ 完成标记存 `settings.onboardingCompleted`。
- 触发条件：`getSystemInfo().modelsInstalled` 为空 且 `!settings.onboardingCompleted` 且未用本地 whisper。
- 推荐模型推导与 P2 一致（`getRecommendedCategory` → 分类首个主模型）；下载复用 `DownModel` 注入式 API + localStorage `downSource`。
- 加速检测复用 `get-gpu-environment` / `get-active-backend`；平台文案 Windows=CUDA/Vulkan、mac=CoreML/Metal。
- `LogDialog` 现有；`dropdown-menu` ui 原语已存在。
- 向导挂载在 `Layout`（全局可重开）；完成/跳过后写标记。

## Task 1: OnboardingDialog + i18n

**Files:**

- Create: `renderer/public/locales/{zh,en}/common.json` 追加 `onboarding.*` key（向导挂在 Layout，Layout 只加载 common namespace → 文案放 common 下的 onboarding 前缀）
- Create: `renderer/components/onboarding/OnboardingDialog.tsx`

步骤设计：

1. **它是怎么工作的**：图示行 `🎬 视频 → 🎙 语音模型(听写) → 🌐 翻译服务(翻译) → 📄 字幕文件`，每个概念一句人话；末行显卡加速=可选增强说明。
2. **下载一个语音模型**：两张可选卡（推荐档 {model}（按内存推导）/ tiny 先快速试试），选中后 DownModel 大按钮下载，后台进行不阻塞下一步；已装任一模型则显示已就绪。
3. **可选增强**：翻译服务说明 +「去配置」（→ resources?tab=providers，关向导）；显卡加速检测结果 + 平台化文案 +「去开启」（→ resources?tab=acceleration，关向导）。

骨架：全屏 Dialog（不可点外关闭，右上「跳过」），底部步骤点 + 上一步/下一步/完成；完成与跳过都 `setSettings({onboardingCompleted:true})`。

## Task 2: Layout 帮助菜单 + 自动触发

**Files:**

- Modify: `renderer/components/Layout.tsx`

- 顶栏右侧（GPU 指示器旁）加「？」DropdownMenu：重开新手引导 / 查看日志（开 LogDialog）/ GitHub。
- mount 时检测触发条件 → 自动打开向导（仅一次）。
- header 右侧布局重构为 `ml-auto flex` 容器（GPU 按钮去掉自身 ml-auto）。
- i18n：common.json 加 `help.menu/reopenOnboarding/viewLogs/github`。

## Task 3: 终验

- tsc 非测试 0 错误；yarn build 通过；提交两个原子 commit；interactive_feedback 冒烟。
