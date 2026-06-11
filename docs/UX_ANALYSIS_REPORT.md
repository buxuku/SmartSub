# SmartSub（妙幕）UX/UI 深度分析与优化重构建议

> 分析日期：2026-06-12 · 基于分支 `feat/resource-hub` @ `549ff7a` · 版本 `v2.17.0-beta.1`
>
> 分析方法：对渲染层全部 8 个页面、60+ 组件、10 个 i18n namespace、主进程任务/存储/IPC 链路进行逐文件代码走查，结合桌面应用 UX 最佳实践（Nielsen 启发式、Apple HIG、Material Design、Electron 官方指南）进行评估。所有结论均附文件路径与行号证据。

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [产品现状与已完成的改进](#2-产品现状与已完成的改进)
3. [用户旅程与关键断点](#3-用户旅程与关键断点)
4. [全局体验层分析](#4-全局体验层分析)
5. [模块级深度分析](#5-模块级深度分析)
6. [问题总清单（按优先级分级）](#6-问题总清单按优先级分级)
7. [重构路线图](#7-重构路线图)
8. [面向未来的设计原则](#8-面向未来的设计原则)

---

## 1. 执行摘要

SmartSub 是一款功能完整度相当高的本地化「音视频 → 字幕 → 翻译 → 校对 → 烧录」桌面工具。当前代码库显示它**刚刚经历了一轮成功的信息架构重构**（资源中心整合、启动台、任务工程化、新手引导），产品的「骨架」已经接近专业水准。

但要达到「人人都容易上手的专业化产品 + 良好视觉 UI」的目标，仍存在四类核心差距：

| 维度       | 现状评分 | 核心差距                                                         |
| ---------- | -------- | ---------------------------------------------------------------- |
| 信息架构   | ★★★★☆    | 骨架已好，残留双入口/术语漂移/namespace 错位                     |
| 核心任务流 | ★★★☆☆    | 并发语义混乱（取消不停、暂停不停、跨工程串扰）、批量操作语义不明 |
| 编辑器体验 | ★★☆☆☆    | 零快捷键、撤销盲区、无未保存保护、长列表性能差                   |
| 视觉系统   | ★★★☆☆    | 无品牌色、默认模板感、暗色模式个别破损、紧凑模式 hack            |

**最值得优先投入的三件事**（详见第 7 节路线图）：

1. **修复任务执行语义**——取消/暂停真正生效、状态按工程隔离、修复「全部已处理」误判 bug。这是用户信任的根基。
2. **给校对编辑器装上「专业工具的肌肉」**——快捷键体系、可靠的撤销/重做、未保存保护、列表虚拟化。校对是用户停留时间最长的界面。
3. **建立轻量设计系统**——一个品牌主色、统一术语表、统一危险操作确认模式、修复暗色模式破损点。

---

## 2. 产品现状与已完成的改进

### 2.1 近期重构成果（应当保留并继续深化的方向）

通过 git 历史（`0fc0ab8`…`549ff7a`）可确认产品刚完成一轮高质量的 IA 重构：

- **启动台替代旧首页**（`renderer/pages/[locale]/home.tsx`）：5 张任务卡片以「用户意图」组织（视频→双语字幕 / 视频→原文字幕 / 翻译已有字幕 / 校对 / 合成），支持拖文件到卡片直接开任务，下方是最近任务列表。这是正确的「以任务为中心」设计。
- **资源中心**（`renderer/pages/[locale]/resources.tsx`）：模型、翻译服务、GPU 加速三类「资源」统一管理，旧路由 `modelsControl` / `translateControl` 改为重定向，保持兼容。
- **任务工程化**（`main/helpers/taskManager.ts`）：文件列表自动持久化为可重命名的「工程」，主进程把任务事件镜像写入存储（`applyTaskEventToProjects`），离开页面状态不丢，启动时用 `TASK_INTERRUPTED` 哨兵标记中断任务。
- **三步新手引导**（`renderer/components/onboarding/OnboardingDialog.tsx`）：概念图解 → 按内存推荐模型 → 可选增强，且支持「暂停去配置 → 右下角胶囊继续」，这个暂停/恢复机制设计得相当细腻。
- **模型管理人性化**（`renderer/components/resources/ModelsTab.tsx`）：「为这台电脑推荐」Hero 区 + 🚀/⚖️/🎯 三档分层 + 量化版折叠 + 速度/精度圆点评分，显著降低了 Whisper 模型选择的专业门槛。
- **文案口语化**：如「还没有语音模型——它负责把人声听写成文字，下载一个就能开始」（`launchpad.json`），把技术概念翻译成了用户语言。

**结论**：本轮分析不是推倒重来，而是在这个正确骨架上找出「下一公里」的优化点。

### 2.2 整体架构速览

```
侧边栏（5 项，可折叠 176/56px）
├─ 任务        → 启动台 home → /tasks/[generate-translate|generate|translate]?project=
├─ 字幕校对    → /proofread（导入 → 列表 → 编辑 三阶段状态机）
├─ 视频合字幕  → /subtitleMerge（文件选择 + 样式 + 预览 + 合成）
├─ 资源中心    → /resources?tab=[overview|models|providers|acceleration]
└─ 设置        → /settings（语言/系统/高级/导入导出/危险区 单页卡片流）
顶栏：品牌+版本+更新火箭 | GPU 状态徽章 | 帮助菜单（重开引导/日志/GitHub）
```

---

## 3. 用户旅程与关键断点

以最核心的「新用户首次把一个视频做成双语字幕」旅程为例，标注每一步的体验断点（🔴 阻断 / 🟡 摩擦 / 🟢 顺畅）：

| 步骤              | 现状                                                                                                | 评级 |
| ----------------- | --------------------------------------------------------------------------------------------------- | ---- |
| 1. 首次启动       | 自动弹新手引导，按内存推荐模型，后台下载                                                            | 🟢   |
| 2. 配置翻译服务   | 引导跳到资源中心，但 17 个服务商平铺，新手不知道选哪个；表单术语专业（structuredOutput、batchSize） | 🟡   |
| 3. 回到启动台     | 引导「继续」胶囊可恢复；横幅提示缺什么                                                              | 🟢   |
| 4. 拖视频到卡片   | 直接建工程并跳转，体验出色                                                                          | 🟢   |
| 5. 确认配置       | 配置条只显示常用 4-5 项，合理；但翻译服务下拉不过滤未配置项，选错要到运行时才报错                   | 🟡   |
| 6. 开始任务       | 阶段链 + 进度条 + 日志面板，反馈充分；但无预计剩余时间                                              | 🟢   |
| 7. 中途想取消     | **点取消后正在转写的文件继续跑，spinner 不停**，用户困惑甚至以为软件卡死                            | 🔴   |
| 8. 全部失败后重试 | **「开始任务」被误判为已处理而拒绝执行**（truthy bug），只能逐行重试                                | 🔴   |
| 9. 完成 → 校对    | 横幅「去校对」只作用于第一个文件，批量场景语义不明                                                  | 🟡   |
| 10. 校对编辑      | 无 Ctrl+S/Ctrl+Z 快捷键；改完不切行直接保存则无法撤销；返回不提示未保存                             | 🔴   |
| 11. 合成到视频    | 衔接预填顺畅；但预览是假字幕文本；点视频 X 会把字幕也清掉（bug）；无法取消 ffmpeg                   | 🟡   |

**洞察**：前半程（获取→配置→开始）经过重构已经很顺；断点集中在**任务执行控制**与**编辑器**这两个「重交互」环节——恰恰是专业用户每天使用频率最高的部分。

---

## 4. 全局体验层分析

### 4.1 信息架构与导航

**做得好的**：

- 五项一级导航以任务动词组织，无多余层级；资源中心二级 Tabs 状态写入 URL query（`resources.tsx` L29-35），可链接、可返回。
- 各处「去下载模型 / 去配置翻译服务」的就地引导链接（`InlineConfigBar.tsx` L97-102、L157-168）形成了良好的配置闭环。

**问题**：

1. **同物异名割裂导航认知**：侧边栏叫「视频合字幕」（`common.json` L134），启动台卡片叫「合成到视频」（`launchpad.json` L13）；侧边栏「字幕校对」vs 卡片「校对字幕」。用户会怀疑这是不是两个功能。
2. **校对/合成与任务流的关系不清**：校对既是独立页面（侧边栏入口）又内嵌在任务页（`tasks/[type].tsx` L290-300 整页替换为 ProofreadEditor），两条路径的数据模型不同（任务 IFiles vs 校对 PendingFile），用户在任务内校对后回到独立校对页找不到记录。建议明确「任务内快捷校对」与「独立校对工程」的关系，或统一为一个校对任务列表。
3. **导航高亮用子串匹配**（`Layout.tsx` L65 `p.includes('home')`）：query 中出现关键词会误判，应改为路径段精确匹配。
4. **模型路径配置双入口**：设置页（`settings.tsx` L427-456）与模型 Tab（`ModelsTab.tsx` L589-600）都能改模型存储路径，两处互不感知。建议设置页只保留链接。
5. **最近任务硬截断 8 条**（`home.tsx` L173 `slice(0, 8)`）且无「查看全部」，老用户工程多了找不到历史。

### 4.2 视觉设计系统

**现状**：`globals.css` 是 shadcn/ui 默认 slate 主题——浅色模式 primary 是近黑深蓝（`222.2 47.4% 11.2%`），**整个应用没有品牌色**。启动台 5 卡片的 indigo/sky/emerald/amber/rose 渐变 chip（`home.tsx` L57-95）是全应用最有设计感的部分，但与其余界面的「黑白灰模板感」形成割裂。

**问题清单**：

1. **无品牌主色**：所有主按钮、激活态、进度条都是近黑色。建议从启动台卡片色系中提一个主色（如 indigo 系 `oklch` 调校），全局应用于 primary/ring/focus，立即提升「产品感」。配合品牌 logo（`FileVideo2` 图标目前是临时占位，`Layout.tsx` L345）。
2. **暗色模式破损点**：`SubtitleList.tsx` L155 失败行样式 `bg-red-50 hover:bg-red-100 border-red-200` 与 L235 `border-red-300` **没有 dark: 变体**，暗色模式下出现刺眼白底红块；L160 还有硬编码 `text-gray-500`。其余组件普遍带 `dark:` 适配，唯独最常用的字幕列表破损。
3. **「紧凑模式」反模式**：`globals.css` L75-131 在屏高 ≤800px 时直接重定义 `.text-sm`、`.gap-4` 等 Tailwind 工具类的全局含义，并以 `header { height: 48px !important }` 覆盖——而 `Layout.tsx` L406 写死 `h-[57px]`，两处真值冲突。应删除该 hack，改用容器查询或在组件内显式响应。
4. **无自定义字体**：全仓库无 font-family 配置，中文界面走系统默认栈。建议至少声明 `font-feature-settings` 与数字等宽（任务行时间/百分比已用 `tabular-nums`，方向正确），可选引入可变字体提升标题质感。
5. **图标语义复用混乱**：侧边栏「任务」用 MonitorPlay、启动台卡片又是另一套自绘 SVG（`TaskIcons.tsx`）；设置页卡片图标（Globe/Cog/Wrench）与资源中心（Bot/Languages/Zap）风格不一。建议统一 lucide 线性风格 + 自绘图标只用于启动台主卡片。
6. **空状态规格不一**：任务列表空状态是固定 `h-[360px]` 虚线框（`TaskRowList.tsx` L120，不随容器伸缩）；校对导入是三张大卡；最近任务空状态只有一行小字（`home.tsx` L362-365）。建议统一「插图 + 主文案 + 副文案 + 主操作」四要素模板。

### 4.3 交互模式一致性

这是「专业感」最容易流失的地方，当前同类操作在不同模块有不同行为：

| 操作 | 有确认                                      | 无确认                                                                                                                                                                                                                 |
| ---- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 删除 | 首页删工程（AlertDialog）、删模型、删加速包 | **任务页清空列表**（清空即删工程，`tasks/[type].tsx` L191-194）、**删自定义服务商**（`ProvidersTab.tsx` L171-175，locale 里的 confirmDeleteMessage 是死键）、**校对列表删行/重置**（`ProofreadFileList.tsx` L588-595） |

1. **统一危险操作策略**：不可恢复的删除一律二次确认（或提供 5 秒撤销 toast，效率更高且不打断心流——推荐后者作为长期方向）。
2. **即改即存的反馈节奏失控**：设置页 VAD 数字输入把保存绑在 onChange 上（`settings.tsx` L284-302），输入「250」触发 3 次保存 + 3 次「保存成功」toast；ProvidersTab 每个字符发一次 IPC（L96-107）。应：输入类控件 debounce 500ms + 失焦提交；**成功不弹 toast（静默 + 行内对勾微反馈），只在失败时打扰用户**。这是「自动保存」类产品的标准做法（Notion/Linear 模式）。
3. **运行中的破坏性操作未防护**：任务运行中仍可删除文件行（`TaskRowList.tsx` 行内 X 不受 `queueBusy` 约束）、可清空列表；删除后主进程继续处理该文件，用户预期完全落空。
4. **CompletionBanner 在 cancelled 状态也显示**、且全部操作只针对 `doneFiles[0]`（`CompletionBanner.tsx` L67-86），多文件完成时「去校对/打开文件夹/合成」语义不明。应改为：单文件→直接操作；多文件→下拉选择或跳转批量视图。

### 4.4 键盘与可访问性

**这是与「专业工具」定位差距最大的一项：全应用除了重命名的 Enter/Escape，没有任何键盘快捷键。**

必备清单（按桌面字幕工具惯例，参照 Aegisub/Subtitle Edit/CapCut）：

| 范围       | 快捷键                   | 动作                         |
| ---------- | ------------------------ | ---------------------------- |
| 全局       | Cmd/Ctrl+O               | 导入文件                     |
| 全局       | Cmd/Ctrl+,               | 打开设置                     |
| 任务页     | Cmd/Ctrl+Enter           | 开始任务                     |
| 任务页     | Delete/Backspace         | 删除选中行（需先支持行选中） |
| 校对编辑器 | Cmd/Ctrl+S               | 保存                         |
| 校对编辑器 | Cmd/Ctrl+Z / Shift+Cmd+Z | 撤销/重做                    |
| 校对编辑器 | Space（非输入态）        | 播放/暂停                    |
| 校对编辑器 | ↑/↓ 或 J/K               | 上一条/下一条字幕            |
| 校对编辑器 | Tab / Shift+Tab          | 原文⇄译文切换焦点            |
| 校对编辑器 | Cmd/Ctrl+F               | 搜索替换                     |

可访问性硬伤：

- hover 才出现的操作按钮（任务行 X、最近任务的重命名/删除、字幕行的 AI/拆分）无 `focus-visible` 兜底，键盘用户不可达。
- 最近任务行是 `div + onClick`（`home.tsx` L373-377），无 `role="button"`、无 tabIndex、无键盘激活。
- 校对编辑器左右分栏固定 50/50（`ProofreadEditor.tsx` L196-198），不可拖拽调宽，长字幕在窄列里频繁换行。

### 4.5 文案与术语系统

文案整体口语化方向正确，但缺一张**术语表**导致同义词漂移：

| 概念       | 出现的写法                                                                                                                | 建议统一                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 语音转文字 | 听写（tasks.json stage.transcribe、onboarding）/ 转写（resources.json L3、common.json modelDesc）/ 识别（launchpad 卡片） | **转写**（行业通用、与「听写」的拟人化保持距离）             |
| GPU        | 显卡加速（common.json L147-148）/ GPU 加速（同文件 L149-152 的 tip）                                                      | **GPU 加速**（设置/技术上下文）+ 首次出现括注「显卡」        |
| 合成功能   | 视频合字幕（侧边栏）/ 合成到视频（卡片）/ 烧录                                                                            | **合成到视频**                                               |
| 工程/任务  | 「最近任务」列表里的条目是工程；任务页底部「N 个任务」实为文件数（tasks.json L63）                                        | 工程=**任务**；文件=**文件**，计数文案改「{{count}} 个文件」 |

其他文案问题：

- 错别字：`zh/home.json` L2 「**源始**字幕设置」应为「原始」。
- 硬编码英文：`ProvidersTab.tsx` L367-370 添加服务商对话框描述 "Create a new custom translation provider..."；`LogDialog.tsx` 描述；`structuredOutput` 下拉直接显示 `disabled/json_object/json_schema` 原始枚举无本地化标签。
- 夸大失真的格式提示：`tasks.json` L58-59 写「支持 MP4, AVI, MKV, MOV, MP3, WAV」「字幕格式：SRT」，实际媒体支持 30+ 种、字幕支持 srt/vtt/ass/ssa/lrc（`main/helpers/ipcHandlers.ts` L19-61）。低估能力会把用户挡在门外。
- 死键清理：`tasks.json` L39 `waiting`、`translateControl.json` 的 confirmDeleteMessage、`en/common.json` 残留的 modelManagement/translationManagement。

### 4.6 国际化质量

- 仅 zh/en 两语言（`next-i18next.config.js`），README 徽章的「日本語」只是 README 文档语言——对外宣传与产品能力不一致，建议补日语或改徽章。
- **namespace 错位**：校对页用 `home` namespace（`proofread.tsx` L24），330 行的 home.json 实际是「校对 + 旧任务页」文案大杂烩；建议拆出 `proofread.json` 与 `editor.json`。
- 全仓库约 **196 处 `t('key') || '中文兜底'`** 写法（集中在 SubtitleEditToolbar 62 处、BatchAiOptimizeDialog 36 处、ProofreadFileList 30 处）：key 缺失时英文界面会蹦中文。应补齐 key 后移除兜底，并加 CI 检查 zh/en key 对等。
- `en/common.json` `headerTitle` 仍是「妙幕 - SmartSub」——若是品牌策略可接受，建议英文界面用「SmartSub」并把「妙幕」放副标题。

### 4.7 系统集成（桌面公民身份）

1. **无自定义菜单**：Electron 默认英文菜单挂在 zh 界面上（`main/` 全目录无 Menu 定制），Edit/View/Window 与产品毫无关系。应提供本地化菜单（含「检查更新」「打开日志」「快捷键速查」）。
2. **macOS 关窗即退出**：`background.ts` `window-all-closed → app.quit()`，违反 macOS「关窗不退出」惯例；配合无托盘，长任务用户不敢关窗。建议 macOS 关窗保活 + Dock 进度条（`app.dock.setBadge` / `setProgressBar` 在转写时显示整体进度）。
3. **任务进度系统级反馈缺失**：已有完成时的系统通知（`taskProcessor.ts` L160-182，做得好），但任务进行中任务栏/Dock 无进度，最小化后只能干等。
4. **更新双重打扰**：下载完成时主进程弹原生 dialog（`updater.ts` L89-111）+ 渲染层又弹 toast（`UpdateNotification.tsx` L46-54）。保留一处即可。另外**没有手动「检查更新」入口**，只有启动 5 秒后的静默自检——帮助菜单应补一项。
5. `webSecurity: false`（`background.ts` L75）是为了 media:// 本地视频，存在安全隐患，长期应迁移到自定义 protocol handler + 保持 webSecurity 开启。
6. 拖拽依赖 `e.dataTransfer.files[i].path`（`home.tsx` L198、`tasks/[type].tsx` L230 带 @ts-ignore）：**Electron 32+ 已移除 File.path**，当前 Electron 30 尚可用，升级即静默坏掉。应尽早迁移 `webUtils.getPathForFile()`。

---

## 5. 模块级深度分析

### 5.1 启动台（home.tsx）

**亮点**：意图导向卡片、拖放即建工程（L188-225）、前置条件横幅互斥展示（L264-290）、最近任务行内重命名。

**问题**：

1. 卡片拖放支持不一致：3 张 slug 卡可拖，校对/合成两张不可拖（L295 `droppable = Boolean(card.slug)`），拖上去触发浏览器默认行为（可能直接打开文件）。至少应阻止默认行为并提示「该入口请点击进入」。
2. 工程状态推断用**当前全局** `userConfig`（L122 `getProjectStatus(project, userConfig)`）：用户事后把翻译服务改为「不翻译」，含翻译阶段的历史工程会被误判「已完成」。工程应快照自己的配置。
3. 最近任务无类型筛选、无搜索、无「查看全部」（仅 8 条）。
4. 数据加载失败仅 console.error（L175-177），UI 无兜底。

### 5.2 任务页（核心流程）

**亮点**：InlineConfigBar 常用项 + AdvancedSheet 低频项的两层配置是教科书式的渐进披露；阶段链 chips（提取→转写→翻译）逐文件可视化；`TASK_INTERRUPTED` 中断恢复闭环；配置实时持久化无需保存按钮。

**P0 级问题**：

1. **「全部已处理」判定 bug**（`TaskControls.tsx` L54-65）：用 truthy 检查 `item.extractAudio && item.extractSubtitle`，而失败时这些字段是字符串 `'error'`——同样为真。**全部失败的列表点「开始任务」会被错误告知「所有文件已处理完成」**，用户只能逐行重试。且该判定不感知 taskType（generateOnly 任务永远判「未处理」，可无限重跑）。修复：复用 `stageUtils.getFileStages + isFileDone`。
2. **取消/暂停不作用于执行中文件**：`cancelTask` 只清空队列（`taskProcessor.ts` L130-134）、`pauseTask` 只停止派发（L191-194），正在 whisper 转写的文件继续跑、spinner 继续转。需要真正的中断信号（whisper.cpp addon 的 abort 回调 / 翻译循环的 cancellation token），至少 UI 上要把「取消=不再开始新文件，正在处理的将完成」讲清楚。
3. **任务状态全局共享、跨工程串扰**：A 工程运行时打开 B 工程，B 页面的 TaskControls 也显示「暂停/取消」，可误杀 A 的任务；LogPanel 日志也是全局混排。队列应携带 projectId，UI 按工程过滤。

**P1 级问题**：

4. 重复导入无去重（`tasks/[type].tsx` L244 直接 append；`useIpcCommunication` 同），同一文件可多次入列重复处理。按 filePath 去重 + toast 提示「已跳过 N 个重复文件」。
5. 清空列表无确认且直接删工程（与首页删除有确认不一致，见 4.3）。
6. 翻译服务下拉不过滤未配置项（`InlineConfigBar.tsx` L139-156），选中未配置服务要到运行时才报错；且**配置条没有「不翻译」选项**，而代码多处保留 `'-1'` 分支（`stageUtils.ts` L25、`TaskControls.tsx` L57）——这是从旧版迁移残留的幽灵状态，generate-translate 任务里用户当前无法临时关闭翻译。
7. `translateRetryTimes` 输入未做 Number 转换（`AdvancedSheet.tsx` L361-366，存成字符串）。
8. 进度信息不足：无单文件 ETA、无文件时长/大小元信息、翻译阶段无「第 N/M 条」细粒度进度（whisper 阶段有 backend 标签，翻译应对齐）。
9. 空状态固定 360px 高不自适应；slug 非法时整页 `return null` 白屏（L288）。

### 5.3 字幕校对模块（用户停留时间最长的界面）

**亮点**：三阶段状态机清晰；视频↔字幕双向联动（点字幕 seek、播放高亮自动滚动，且处理了 react-player 0-1 秒按百分比 seek 的坑，`useVideoPlayer.ts` L50-65）；翻译失败导航（统计 + 上下跳转）；单条/批量 AI 优化闭环（批量还有三步向导 + 逐条 diff 审核 + 选择性应用，`BatchAiOptimizeDialog.tsx`）。

**P0 级问题**：

1. **撤销盲区**（`useStandaloneSubtitles.ts` L225-242、L408-425）：逐字输入不入历史，只有「切换当前字幕行」时才把编辑快照补进历史。**改完一行不切行直接 Cmd+S（哦不，没有 Cmd+S，是点保存按钮）→ 这次修改永远无法撤销**。且历史快照用 `JSON.parse(JSON.stringify())` 全量深拷贝 ×50 条上限，几千条字幕时内存放大严重。建议改为按行 diff 的命令模式（command pattern）历史。
2. **无未保存保护**：「返回列表」「标记完成」都不保存、不提示（`ProofreadEditor.tsx` L156-174、`proofread.tsx` L79-96）；「标记完成」只改状态字段，用户极易误以为内容已保存。需要 dirty 标记 + 离开拦截 + 「标记完成」隐含保存。
3. **保存直接覆盖原文件、无备份**（`useStandaloneSubtitles.ts` L245-280 三路写盘）。专业工具至少要有 `.bak` 或「另存为」，否则一次误操作毁掉原始字幕。

**P1 级问题**：

4. **零快捷键**（见 4.4）——校对是高频重复操作场景，键盘效率直接决定专业用户去留。
5. **长列表性能**：无虚拟化，几千条字幕渲染几千个 Textarea；每 100ms 播放进度回调对全列表 `findIndex`（O(n)×10/秒）；每次按键全数组浅拷贝重渲染。2 小时电影（~2000 条）会明显卡顿。方案：`@tanstack/react-virtual` 虚拟化 + 当前字幕索引用二分/区间索引 + 行级 memo。
6. **时间轴不可编辑**：列表只显示时间文本，不能直接改起止时间，只能靠整体偏移/拆分间接调整。字幕工具的基本功缺失。
7. 搜索替换偏弱：无逐条确认替换、无高亮定位、无正则/大小写选项；`matchCount` 统计的是含关键词的**条数**而非出现**次数**（`SubtitleEditToolbar.tsx` L149-168）。
8. 合并字幕靠手填 1-based 序号（L631-695）而不是列表多选；拆分译文按字符比例硬切（L995-999）对中英混排不准。
9. 批量 AI 优化**不可取消**：`isPaused` 状态声明了从未使用，关闭弹窗不中断主进程任务（`BatchAiOptimizeDialog.tsx` L662-666）。
10. 「校对中」状态误导：进入编辑即置 `proofreading` 并渲染旋转 Loader（`ProofreadFileList.tsx` L297-303），返回列表不重置，看起来像后台有任务在跑。
11. AI 优化只写 `targetContent`，纯转写（无翻译）场景整个 AI 入口隐藏——无法用 AI 修正转写错别字，这是真实需求。
12. 视频播放器自定义控制条整块被注释（`VideoPlayer.tsx` L67-148），倍速/±5 秒/上下条按钮成死代码，只剩原生 controls；而 hook 里这些能力都实现了。要么恢复精简版控制条，要么删除死代码。
13. 路径处理多处手写 `split('/')`（`proofreadUtils.ts` L83、L102）不兼容 Windows 反斜杠；字幕导入伪造 `.mp4` 路径复用检测逻辑（L118）是脆弱 hack。
14. 导入字幕语言检测启发式 `lang === 'en' ? 'source' : 'translated'`（`ProofreadImport.tsx` L119）假定英语永远是源语言——对中→英用户完全反了。应结合用户最近任务配置判断。

### 5.4 字幕合成模块

**亮点**：预设 → 基础 → 高级三层样式渐进披露；九宫格 ASS 对齐选择器；与任务完成横幅的 query 预填衔接（`?video=&subtitle=`）。

**问题**：

1. **清除按钮 bug**：`SubtitleMergePanel.tsx` L94-95 把 `onClearVideo` 和 `onClearSubtitle` 都绑到 `clearFiles()`——点视频卡的 X 连字幕一起清空，反之亦然。
2. **预览是假的**：`VideoPreview.tsx` L27 固定示例文本「这是字幕预览效果」，不渲染真实字幕、不随时间轴变化；CSS 模拟与 ffmpeg/ASS 实际渲染存在偏差（`styleUtils.ts` 注释自认）。专业用户需要真实预览：解析选中的字幕文件，按 currentTime 渲染对应条目（前端已有完整解析能力，复用 `useStandaloneSubtitles` 的解析层即可）。
3. **合成不可取消**：ffmpeg 任务一旦开始没有取消按钮（`MergeButton.tsx`），长视频烧录动辄几十分钟。
4. 完成状态不随换文件重置：合成完成后换一个视频，进度条仍停留 100%。
5. 输出格式单一：只能烧录（硬字幕），没有「封装软字幕（mkv mux）」选项——后者秒级完成且无损，是大量用户的真实需求，ffmpeg 同样能做。

### 5.5 资源中心

**亮点**：Overview 三卡片仪表盘 + 就地一键下载/启用；GPU 卡的状态分层（绿/黄/灰）、降级原因展示、诊断信息复制（`GpuAccelerationCard.tsx` L591-636、L1026-1127）对排障非常友好。

**问题**：

1. **17 个翻译服务商平铺无引导**（`ProvidersTab.tsx` 左栏）：新手面对百度/火山/DeepLX/Ollama/DeepSeek… 不知道选哪个。建议：① 按「免费起步 / 传统机翻 / AI 翻译」分组；② 顶部加「不知道选哪个？」推荐卡（如：免费试用→DeepLX/Ollama，质量优先→DeepSeek/GPT）；③ 把 onboarding 里已有的推荐文案（`common.json` L189）复用过来。
2. **测试翻译写死 en→zh**（`ProvidersTab.tsx` L184-188）：应使用用户当前任务配置的语向，否则测试通过≠实际可用。测试结果只存在于 5 秒 toast 中，应改为表单内常驻结果区。
3. **选中态潜在 bug**：`loadProviders` 用 `storedProviders[0].type` 设置选中（L92），其余逻辑按 `id` 匹配——首个是自定义服务商（id=`openai_时间戳`、type=`openai`）时会选中不存在的面板。
4. `SearchableSelect` 在父组件 render 内定义（`ProviderForm.tsx` L156），每次重渲染重建组件导致 Popover 重挂载、搜索框失焦——React 反模式，需提到模块顶层。
5. AI 服务商表单专业门槛高：30 行默认 systemPrompt 塞在 3 行 textarea；`structuredOutput` 无人话解释；batchSize/requestInterval 说明藏在 tooltip。建议表单也做「基础（apiKey+模型）/ 高级（提示词、批量、结构化输出）」两层折叠。
6. **自定义参数编辑器过度工程化**（`CustomParameterEditor.tsx` 894 行 + `DynamicParameterInput.tsx` 481 行 + `useParameterConfig` 700+ 行）：给请求加一个 `temperature=0.3` 要经历 7 步、每个参数占一整张 Card。功能深度与目标用户严重错位。建议默认呈现为简单的 key-value 表格行内编辑，把类型校验/导入导出收进「高级」菜单。
7. 模型下载失败只有 console.error（`DownModel.tsx` L74-77），用户侧无任何失败提示；全局下载互斥时其他按钮只是变灰，无 tooltip 解释原因。
8. 下载源话术两套：模型叫「国内加速源/HuggingFace 官方源」，加速包叫「GitHub 代理（国内加速）」——可统一为「自动选择最快源」+ 高级里手动切换。

### 5.6 设置页

**亮点**：高级设置折叠收纳极客选项（本地 whisper 命令、VAD 六参数）方向正确；配置加密导入导出完整；危险区红色隔离。

**问题**：

1. VAD 六个裸数字输入（阈值 0-1、时长 ms、重叠 0-1…）即使在「高级」里也过于裸露：无滑杆、无单位后缀、无「恢复默认」按钮、无预设档位（安静演讲/嘈杂环境/音乐人声）。每键击保存+toast 见 4.3。
2. GPU 迁移过渡卡（L520-536，注释自述「一个版本后可移除」）——按计划移除即可。
3. 设置页与资源中心的职责边界可以再清晰：语言/更新/路径/导入导出留在设置，「模型路径」建议移除（见 4.1.4）。
4. 缺「关于」区块：版本、检查更新按钮、开源协议、致谢、日志目录入口——目前版本号藏在顶栏，检查更新无手动入口。

### 5.7 新手引导与帮助系统

**亮点**：暂停/恢复机制、按内存推荐、模型已装则显示「这一步完成了」。

**问题**：

1. 引导覆盖「准备资源」但不覆盖「完成第一个任务」：第 3 步结束就放手，新用户回到启动台还要自己摸索拖文件→开始→等待→产物在哪。建议加第 4 步「试一试」：内置 10 秒示例音频，一键跑通全流程，让用户在 30 秒内看到第一个字幕文件（aha moment 前置）。
2. 帮助体系单薄：帮助菜单只有「重开引导/日志/GitHub」。缺：快捷键速查（实现快捷键后）、常见问题（如 mac「已损坏」修复、CUDA 闪退换版本——README 里有但应用内没有）、日志目录直达。
3. 无模型时任务卡片仍可点进（仅 Badge 提示），进去后配置条变「去下载模型」链接——可以接受，但若引导第 2 步下载还没完成就进任务页，没有下载进度的全局可见性（建议顶栏或侧边栏显示模型下载进度 pill）。

### 5.8 更新机制

见 4.7.4：双重提示去一、补手动检查入口。另外 Mac 判断用 `navigator.userAgent.includes('Mac')`（`UpdateDialog.tsx` L43-48）应换成主进程 `process.platform` 注入。

---

## 6. 问题总清单（按优先级分级）

### P0 — 功能性缺陷，破坏用户信任（建议立即修复）

| #   | 问题                                                               | 位置                                     |
| --- | ------------------------------------------------------------------ | ---------------------------------------- |
| 1   | 全部失败的列表点「开始任务」被误判「已处理」拒绝执行（truthy bug） | `TaskControls.tsx` L54-65                |
| 2   | 取消/暂停不作用于执行中文件，spinner 永转直到重启                  | `taskProcessor.ts` L130-134/L191-194     |
| 3   | 任务状态/日志全局共享，跨工程互相误操作                            | `getTaskStatus`/`getLogs` 全局单例       |
| 4   | 合成页点视频 X 连字幕一起清空（清除回调 bug）                      | `SubtitleMergePanel.tsx` L94-95          |
| 5   | 校对编辑「不切行就保存」的修改无法撤销                             | `useStandaloneSubtitles.ts` L408-425     |
| 6   | 校对退出/标记完成无未保存提示，保存覆盖原文件无备份                | `ProofreadEditor.tsx` L156-174           |
| 7   | 暗色模式字幕列表失败行白底刺眼（缺 dark: 变体）                    | `SubtitleList.tsx` L155/L235             |
| 8   | 拖拽依赖已废弃的 File.path，Electron 升级即坏                      | `home.tsx` L198、`tasks/[type].tsx` L230 |
| 9   | ProvidersTab 首项为自定义服务商时选中不存在面板                    | `ProvidersTab.tsx` L92                   |

### P1 — 显著体验断点（近期版本解决）

| #   | 问题                                                       | 位置/详见    |
| --- | ---------------------------------------------------------- | ------------ |
| 10  | 全应用零快捷键（保存/撤销/播放/跳转/导入/开始）            | 4.4          |
| 11  | 校对列表无虚拟化，长视频卡顿                               | 5.3.5        |
| 12  | 危险操作确认策略不一致（清空列表/删服务商/删校对行无确认） | 4.3.1        |
| 13  | 即改即存 toast 轰炸 + 每键击 IPC                           | 4.3.2        |
| 14  | CompletionBanner 多文件场景只服务第一个文件                | 4.3.4        |
| 15  | 重复导入不去重                                             | 5.2.4        |
| 16  | 运行中可删行/清空，主进程继续处理                          | 4.3.3        |
| 17  | 翻译服务下拉不过滤未配置项；无「不翻译」选项               | 5.2.6        |
| 18  | 合成预览是假字幕，不随时间轴变化                           | 5.4.2        |
| 19  | 合成/批量 AI 优化不可取消                                  | 5.4.3、5.3.9 |
| 20  | 17 服务商平铺无推荐分组；测试翻译写死 en→zh                | 5.5.1-2      |
| 21  | 时间轴不可直接编辑                                         | 5.3.6        |
| 22  | 术语漂移（转写/听写/识别、显卡/GPU、合成命名）+ 错别字     | 4.5          |
| 23  | 无品牌主色，视觉模板感                                     | 4.2.1        |
| 24  | macOS 关窗即退、默认英文菜单、无 Dock 进度                 | 4.7.1-3      |
| 25  | 工程状态用当前全局配置误判历史工程                         | 5.1.2        |

### P2 — 打磨项（持续迭代）

文案格式提示失真（#4.5）、i18n 兜底清理与 CI 校验（#4.6）、紧凑模式 hack 移除（#4.2.3）、空状态模板统一（#4.2.6）、最近任务查看全部/搜索（#5.1.3）、设置页「关于」区块（#5.6.4）、引导第 4 步示例任务（#5.7.1）、软字幕封装选项（#5.4.5）、AI 优化支持纯转写模式（#5.3.11）、VAD 预设档位（#5.6.1）、参数编辑器简化（#5.5.6）、更新双提示去重（#5.8）、死代码清理（VideoPlayer 注释块、isPaused、死 i18n 键）、`webSecurity:false` 迁移（#4.7.5）、Windows 路径兼容（#5.3.13）。

---

## 7. 重构路线图

按「先止血 → 再提效 → 后塑形」三阶段推进，每阶段都可独立发版：

### Phase 1 「信任修复」（约 1-2 周工作量）

> 目标：核心流程没有谎言——按钮说什么就做什么。

- 修复 P0 全部 9 项（多为局部修改，互相独立）。
- 任务执行语义重构是最大项：队列携带 projectId、cancel 发真实中断信号（whisper addon abort + 翻译 cancellation token）、UI 文案明确「停止派发 vs 中断当前」。
- 统一危险操作：抽一个 `useConfirmOrUndo` hook（AlertDialog 或 5 秒撤销 toast），替换全部裸删除。
- 保存反馈降噪：输入控件 debounce + 失焦提交，成功静默、失败 toast。

### Phase 2 「编辑器专业化」（约 2-3 周）

> 目标：校对编辑器达到「专业字幕工具」基线，留住重度用户。

- 快捷键体系（4.4 清单）+ 帮助菜单「快捷键速查」面板。
- 撤销系统重构为命令模式（行级 diff），覆盖逐字编辑；dirty 状态 + 离开保护 + 保存备份（.bak 或另存为）。
- 列表虚拟化（@tanstack/react-virtual）+ 播放联动索引优化 + 行级 memo。
- 时间轴行内编辑（点击时间出现 mm:ss,ms 输入，校验区间重叠）。
- 合并改为列表多选（Shift+点选）触发；搜索替换加逐条确认与高亮。
- 批量 AI 优化可取消（IPC abort 通道）；AI 优化支持纯转写模式（优化 sourceContent）。
- 合成页真实字幕预览（复用解析层，按 currentTime 渲染当前条）+ ffmpeg 取消按钮 + 软字幕封装选项。

### Phase 3 「品牌与一致性」（约 1-2 周 + 持续）

> 目标：从「能用的工具」到「有性格的产品」。

- 设计 token 升级：定义品牌主色（建议 indigo 域）+ 完整 oklch 色板 + focus ring 统一；移除紧凑模式 hack；补齐暗色破损。
- 术语表落地（4.5 表格）：一次性全量替换 + 贡献者文档注明；namespace 重组（拆 proofread/editor，清死键），CI 校验 zh/en 对等。
- 桌面公民身份：本地化应用菜单、macOS 关窗保活 + Dock 进度、手动检查更新、更新提示去重。
- 引导补「示例任务」第 4 步；服务商分组与推荐卡；空状态四要素模板统一。
- 信息架构收尾：移除 GPU 过渡卡、设置页模型路径改链接、侧边栏命名统一（任务/校对/合成到视频/资源中心/设置）、最近任务「查看全部」页。

### 节奏建议

P0 修复可以直接随 2.17 正式版发布；Phase 2 是 2.18 的主题（「编辑器大版本」是很好的对外叙事）；Phase 3 伴随 2.18-2.19 持续落地。每项改动建议配 before/after 截图进 Changelog——这轮 IA 重构的成果也值得在 release notes 里系统性展示。

---

## 8. 面向未来的设计原则

沉淀本次分析，建议团队在后续迭代中遵循五条原则（可写入 CONTRIBUTING）：

1. **按钮即契约**：任何控件的文案必须与系统实际行为一致。「取消」就要停，「已完成」就要真的完成。做不到的能力，宁可把文案写保守（「停止派发新任务」）。
2. **渐进披露，但不藏断点**：常用项放表层、专业项收折叠（InlineConfigBar/AdvancedSheet 模式已验证成功），但「下一步要什么」的前置条件必须在表层可见（缺模型/缺服务的横幅模式已验证成功，推广到所有模块）。
3. **破坏不可逆，必须可反悔**：删除/覆盖/清空三类操作，要么二次确认，要么 5 秒撤销，要么留备份。三者必居其一。
4. **成功安静，失败大声**：自动保存成功不打扰（最多行内微反馈），失败必须显式可见且可重试。Toast 是稀缺资源。
5. **键盘是专业用户的母语**：高频界面（编辑器、任务页）的每个核心动作都要有快捷键，并在 tooltip 中标注。

---

## 附录 A：本次分析覆盖的文件清单（节选）

- 页面：`home.tsx`、`tasks/[type].tsx`、`proofread.tsx`、`subtitleMerge.tsx`、`resources.tsx`、`settings.tsx`、`modelsControl.tsx`、`translateControl.tsx`
- 任务流：`TaskControls.tsx`、`InlineConfigBar.tsx`、`AdvancedSheet.tsx`、`TaskRowList.tsx`、`CompletionBanner.tsx`、`LogPanel.tsx`、`stageUtils.ts`、`taskTypes.ts`、`useFormConfig.tsx`、`useIpcCommunication.tsx`
- 校对/编辑：`ProofreadImport/FileList/Editor/TaskList.tsx`、`SubtitleList.tsx`、`SubtitleEditToolbar.tsx`、`BatchAiOptimizeDialog.tsx`、`VideoPlayer.tsx`、`CurrentSubtitle.tsx`、`VideoInfo.tsx`、`useStandaloneSubtitles.ts`、`useVideoPlayer.ts`、`proofreadUtils.ts`
- 合成：`SubtitleMergePanel.tsx`、`FileSelector.tsx`、`VideoPreview.tsx`、`SubtitlePreviewOverlay.tsx`、`StylePresets.tsx`、`Basic/AdvancedStyleSettings.tsx`、`AlignmentSelector.tsx`、`MergeButton.tsx`、`useSubtitleMerge.ts`、`styleUtils.ts`、`constants.ts`
- 资源：`OverviewTab.tsx`、`ModelsTab.tsx`、`ProvidersTab.tsx`、`AccelerationTab.tsx`、`ProviderForm.tsx`、`GpuAccelerationCard.tsx`、`CustomParameterEditor.tsx`、`DynamicParameterInput.tsx`、`DownModel*.tsx`、`DeleteModel.tsx`、`Models.tsx`、`providerUtils.ts`、`types/provider.ts`
- 全局：`Layout.tsx`、`OnboardingDialog.tsx`、`ThemeToggle.tsx`、`UpdateDialog.tsx`、`UpdateNotification.tsx`、`LogDialog.tsx`、`SavePathNotice.tsx`、`globals.css`、`tailwind.config.js`、`_app.tsx`
- 主进程：`background.ts`、`create-window.ts`、`taskProcessor.ts`、`taskManager.ts`、`ipcHandlers.ts`、`updater.ts`、`proofreadStore.ts`
- i18n：`zh|en` × `common/home/tasks/launchpad/settings/resources/modelsControl/translateControl/subtitleMerge/parameters.json`

## 附录 B：竞品参照基准

| 能力          | Aegisub/Subtitle Edit | CapCut/剪映    | SmartSub 现状          |
| ------------- | --------------------- | -------------- | ---------------------- |
| 快捷键体系    | 完整且可自定义        | 核心操作全覆盖 | 无                     |
| 时间轴编辑    | 波形图+逐帧           | 拖拽块         | 不可编辑               |
| 撤销深度      | 无限                  | 深             | 50 条且有盲区          |
| 长字幕性能    | 万条流畅              | 流畅           | 千条卡顿               |
| 批量转写+翻译 | 无/弱                 | 云端收费       | **本地免费，核心优势** |
| 新手上手      | 陡峭                  | 平缓           | 平缓（引导良好）       |

SmartSub 的差异化位置非常清晰：**「比专业工具好上手，比剪辑软件懂字幕，且完全本地免费」**。Phase 2 把编辑器基本功补齐后，这个定位就完全立得住了。
