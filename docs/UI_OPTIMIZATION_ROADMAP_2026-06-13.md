# SmartSub 界面优化路线图（2026-06-13）

> 基于分支 `feat/resource-hub` 最新提交，在资源中心（模型 / 翻译服务 / 加速概览）一轮集中优化之后，对其余界面做的**代码走查 + 优先级梳理**。  
> 更早期的全量 UX 审计见 [`docs/UX_ANALYSIS_REPORT.md`](./UX_ANALYSIS_REPORT.md)；本文聚焦**尚未落地**或**仍与资源中心新范式不一致**的部分。

---

## 1. 已完成（资源中心，本轮）

| 模块                     | 主要改动                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **翻译服务**             | 搜索、分组折叠、已配置筛选、移动端布局、测试 en→zh、错误 i18n、选中持久化、与任务 `translateProvider` 同步 |
| **模型**                 | 搜索、已安装筛选记忆、变体展开记忆、推荐 Hero 置顶、sticky 工具栏、打开文件夹、失败 toast、下载完成刷新    |
| **加速（资源中心 Tab）** | GPU 组件拆分、状态 Hero、CUDA 下载 Sheet、诊断面板、与 Overview 共享 `deriveGpuDisplayState`               |
| **概览**                 | 三卡装饰统一、GPU 展示文案、跳转各 Tab                                                                     |
| **基础设施**             | `useLocalStorageState` hydration 修复、`providerPanelUtils` / `modelPanelUtils`、测试翻译结果校验          |

**可复用的 UI 范式（建议其它页面看齐）：**

- Sticky 工具条 + 搜索 + 筛选开关
- localStorage 记忆用户视图偏好
- 失败必 toast，成功可轻提示
- 页面级单一 `TooltipProvider`
- 窄屏 `flex-col` + 操作区换行
- 焦点环用 `ring-inset` 避免 `overflow-auto` 裁切

---

## 2. 全局 / 导航（Layout）

**现状：** 侧栏导航清晰，含 GPU 状态 Badge、更新入口、日志/FAQ/快捷键/新手引导；任务与启动台合并为同一 Nav 高亮。

**P0**

- **GPU Badge 与资源中心加速 Tab 文案统一**：侧栏仍可能出现与 Overview 不一致的旧表述；应 exclusively 使用 `deriveGpuDisplayState()` + 同一套 i18n key。
- **运行中任务指示**：侧栏/标题栏缺少「有任务在跑」的全局提示，用户切到校对/设置时易忘记后台任务。

**P1**

- **Nav 折叠态**：折叠后仅图标，Tooltip 已有；可补 `aria-current` 与键盘焦点顺序。
- **日志 Dialog**：任务页 LogPanel 与全局 LogDialog 内容混排（Updater 日志开场）——应分 Tab 或过滤来源 `[UX 报告已提及]`。

**P2**

- **面包屑 / 上下文标题**：深层页（任务工程名、校对批次名）与侧栏「任务」高亮语义略脱节。
- **最近任务** 入口仅在启动台，Nav 无直达；高频用户可多一个 History 快捷入口。

**P3**

- macOS 关窗行为、Dock 进度等平台公民项（见 UX 报告 §4.6）。

---

## 3. 启动台（`/home`）

**现状：** 五张任务卡片 + 最近工作区列表；卡片链到 `/tasks/[slug]` 或 proofread/merge；有模型/翻译配置缺失警告。

**P0**

- **前置条件阻断可点击**：`needsModel` 卡片在缺模型时仍进任务页再报错；应在卡片上直接 CTA「去下载模型」链到 `resources?tab=models`（Overview 已有类似模式，启动台应对齐）。
- **翻译服务未配置**：translate / generate-translate 卡片同样应链到 `resources?tab=providers`。

**P1**

- **最近工作区**：与 `/recent-tasks` 功能重叠；启动台只展示 N 条 +「查看全部」即可，避免两处维护感。
- **搜索 / 筛选**：工作项多时启动台无搜索（recent-tasks 有）；可考虑启动台只保留摘要，重搜索放 recent-tasks。
- **空状态**：仅有 EmptyState；可补「拖拽媒体快速开始」示意（与任务页一致）。

**P2**

- 卡片描述文案与资源中心推荐语统一（避免 medium vs large-v3-turbo 双信源冲突 `[UX 报告]`）。
- 工作项删除/重命名与 recent-tasks 交互完全统一（confirm、toast）。

**P3**

- 卡片排序/ pin 常用任务类型（localStorage）。

---

## 4. 任务页（`/tasks/[type]`）

**现状：** 工程化（projectId）、InlineConfigBar、AdvancedSheet、TaskRowList、CompletionBanner、LogPanel、内嵌 ProofreadEditor；热键、拖拽导入、翻译服务商默认已接 `resolveDefaultTranslateProviderId`。

**P0 — 信任根基（与 UX 报告一致，仍未系统性解决）**

- **取消 / 暂停是否真正停止主进程任务**（需与 backend 对齐验收）。
- **跨工程状态隔离**：`taskStatus`、日志、进度不应串扰。
- **「全部已处理」误判**、失败文件批量重试语义。

**P1**

- **InlineConfigBar → 资源中心深链**：模型、翻译服务商下拉旁加「配置…」跳转 resources 对应 Tab（减少 Settings 双入口感）。
- **CompletionBanner**：失败集中处理入口（筛选失败行、一键重试失败）。
- **LogPanel**：默认过滤任务日志；Updater 日志分开展示。
- **AdvancedSheet**：VAD 等高级项与 Settings 重复——应明确「任务覆盖 vs 全局默认」文案。
- **Sticky 顶栏**：文件列表 + ConfigBar 在长列表滚动时吸顶（参考 ModelsTab / ProvidersTab）。

**P2**

- **响应式**：窄屏下 TaskRowList 操作列拥挤；CompletionBanner 按钮换行。
- **导入区**：拖拽态视觉与 proofread 统一。
- **工程重命名**：inline edit 已有；失败 toast、空名拦截可加强。

**P3**

- 任务模板（保存常用 config 预设）。
- 批量导出/打开输出目录（已有单文件 openFolder，可批量）。

---

## 5. 字幕校对（`/proofread`）

**现状：** 三阶段 import → list → edit；支持 workItem deep link；ProofreadEditor 功能完整但偏「重」。

**P0 — 编辑器专业度（UX 报告核心痛点）**

- **未保存离开保护**：切换文件/返回列表/关页时无统一 dirty guard。
- **翻译失败「红屏轰炸」**：89/91 失败时缺「仅看失败 / 下一条失败」工作流 `[UX 报告]`。
- **顶层导航残留**：编辑态仍可见 App 级「新建/历史」切换，认知层级混乱 `[截图]`。

**P1**

- **快捷键**：ShortcutsHelpDialog 已存在，但编辑器内 undo/redo、上下条、播放/暂停等需真正绑定并写入帮助表。
- **列表密度**：当前一屏 ~3 条；compact 行高 + 虚拟列表（react-window 等）。
- **失败行样式**：左缘细条 + 图标，而非整行红底。
- **导入失败 toast**：ProofreadImport 错误路径需与 ModelsTab 同级反馈。

**P2**

- **Sticky 工具栏**：SubtitleEditToolbar 吸顶。
- **批量 AI 优化**：BatchAiOptimizeDialog 进度与取消语义清晰化。
- **与任务页校对入口统一**：TaskPage 内嵌 ProofreadEditor 与独立 proofread 路由行为一致（保存路径、导出）。

**P3**

- 术语表 / 一致性检查、双语文案对齐辅助。

---

## 6. 视频合字幕（`/subtitleMerge`）

**现状：** SubtitleMergePanel 单页；支持 query 预填 video/subtitle；MergeButton + 样式预设。

**P0**

- **禁用按钮提示不准**：已选文件仍提示「请先选择视频和字幕」——真实卡点常为输出路径 `[UX 报告 · 双证]`；应用具体字段级提示。
- **输出路径未设置**：应在面板顶部显性展示 SavePathNotice 或等价引导。

**P1**

- **预览与样式**：VideoPreview + SubtitlePreviewOverlay 好；缺「导出前 10 秒试看」降低长视频等待焦虑。
- **样式预设**：StylePresets 与 Advanced 分区对新手仍偏技术；加「电影 / 短视频 / 教程」示例预设名。
- **完成后续**：merge 成功后一键 openFolder（MergeButton 部分已有，与 CompletionBanner 对齐）。

**P2**

- **响应式**：BasicStyleSettings / Advanced 两栏在窄屏改 Tab。
- **错误 i18n**：ffmpeg 原始错误映射用户可读文案。

**P3**

- 与 proofread 导出字幕衔接（「去烧录」深链并带 subtitle query）。

---

## 7. 设置（`/settings`）

**现状：** 大表单 ~1100 行，Collapsible 分区：语言、路径、VAD、Whisper、GPU（GpuAccelerationCard）、关于等；与资源中心有职责重叠。

**P0**

- **职责边界模糊**：模型路径、GPU、翻译相关项在 Settings 与 Resources 双入口；建议 Settings 只保留「全局行为」，资源型配置只留 Resources，Settings 用「前往资源中心 →」链接（部分已有 ArrowRight，需全覆盖）。
- **保存反馈**：大表单改项多，缺「已保存」轻提示（ModelsTab 的 saveFlash 范式可复用）。

**P1**

- **GPU 区块**：Settings 内 GpuAccelerationCard 与 Resources → AccelerationTab 完全重复——Settings 应改为摘要 + 跳转，避免两处改同一配置。
- **VAD 预设**：三档预设好；缺「恢复默认」与当前值 diff 展示。
- **导入/导出配置**：若有 backup JSON，失败需 toast（对齐 importModel 范式）。

**P2**

- **Sticky 保存栏**：长页滚动时底部或顶部固定「保存 / 重置」。
- **搜索设置项**：设置项多时快速定位。
- **TooltipProvider 合并**。

**P3**

- 设置项分级（基础 / 高级 / 实验性）。

---

## 8. 最近任务（`/recent-tasks`）

**现状：** 搜索 + 类型筛选 + 分页 + WorkItemList；功能较完整。

**P1**

- **筛选/搜索记忆** localStorage（与 ModelsTab 一致）。
- **加载失败 toast**（目前仅 console.error）。
- **空状态 CTA** 链到启动台对应卡片。

**P2**

- 批量删除、批量打开。
- 与启动台「最近工作区」数据同步策略文档化（同一 IPC `getWorkItems`）。

---

## 9. 跨切面优化清单

| 主题             | 现状                                             | 建议                                                        |
| ---------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| **错误反馈**     | 资源中心已统一；任务/校对/设置部分仍 silent fail | 约定：用户触发的 IPC 必 toast + i18n                        |
| **localStorage** | hydration bug 已修                               | 新偏好均用 `useLocalStorageState`；key 集中到 `*PanelUtils` |
| **搜索框 focus** | ModelsTab 已 ring-inset                          | ProvidersTab / recent-tasks / settings 同步排查             |
| **i18n**         | `yarn check:i18n` 已 CI                          | 错误码映射表（providerError 范式扩展到 task/merge/ffmpeg）  |
| **响应式**       | Resources 两 Tab 已适配                          | 任务行、校对列表、合成页为下一批                            |
| **深链**         | resources?tab=、tasks query                      | 扩展：`?tab=providers&provider=`、缺模型 `?tab=models`      |
| **共享 Hook**    | Overview/Models 各自拉 systemInfo                | P3 可抽 `useSystemInfo`；非必须但减重复                     |
| **设计系统**     | 资源中心 CardDecor 三色                          | 推广到启动台卡片、任务状态 Badge、Banner                    |

---

## 10. 推荐实施顺序（不含资源中心 P3）

```text
Phase A — 信任与阻断（1–2 周）
  任务取消/隔离/失败语义
  启动台前置条件 CTA → 资源中心
  合成页禁用提示修正 + 输出路径引导
  设置 vs 资源中心职责切分（GPU 去重）

Phase B — 校对编辑器（2–3 周）
  未保存保护、失败集中处理、列表密度/虚拟化
  快捷键落地 + 失败行视觉降噪

Phase C — 任务页体验（1–2 周）
  Sticky ConfigBar、Log 分源、CompletionBanner 失败流
  InlineConfigBar 深链资源中心

Phase D — 打磨（持续）
  设置搜索/sticky 保存、recent-tasks 记忆
  全局 GPU Badge、响应式第二批
  设计系统状态色
```

---

## 11. 与旧 UX 报告的关系

| UX 报告章节   | 本文状态                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------ |
| §6.5 资源中心 | **大部分已实施**；剩余：加速 Tab P3（磁盘/英文模型/GPU 引导）、Overview 与 Settings GPU 完全去重 |
| §6.2 任务页   | **部分**（translateProvider 同步）；取消/暂停/日志仍待 Phase A/C                                 |
| §6.3 校对     | **未动**；仍为最高 ROI 的 Phase B                                                                |
| §6.4 合成     | **未动**；Phase A 小改即可显著减困惑                                                             |
| §6.6 设置     | **GPU 已 refactor**；与 Resources dedup 待 Phase A                                               |
| §6.1 启动台   | **未动**；Phase A 前置 CTA                                                                       |

---

## 12. 结论

资源中心已成为 SmartSub **交互范式最完整**的区域；其余页面的主要差距不在「有没有功能」，而在：

1. **失败与阻断是否说清楚**（toast、字段级提示、深链补配置）
2. **长流程是否有专业工具感**（校对编辑器、任务失败流）
3. **全局配置是否单一信源**（Settings ↔ Resources ↔ 任务 InlineConfig）

建议优先 **Phase A + Phase B**，再批量套用资源中心已验证的 sticky / 搜索 / localStorage / 错误 i18n 模式到任务页与 recent-tasks。

---

_文档维护：随功能迭代更新「已完成」表与 Phase 勾选。_
