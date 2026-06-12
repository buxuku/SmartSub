# UX 重构进度交接文档

> 用途：换机/换会话续作的上下文锚点。配合 `docs/UX_ANALYSIS_REPORT.md`（问题清单与路线图原文）阅读。
> 最后更新：2026-06-12，分支 `feat/resource-hub`。

## 1. 工作流程约定（续作时沿用）

1. 每个批次走完整闭环：探索现状 → 设计呈现并经用户确认 → 写设计文档（`docs/superpowers/specs/`）→ 写实施计划（`docs/superpowers/plans/`）→ 按 task 实施 → 门禁 → interactive_feedback 交接实机验证清单，用户确认后才进下一批次。
2. 每个 task 一个 commit，commit message 用 conventional 风格（feat/fix/refactor + scope）。
3. 实施过程中用户反馈的 bug 立即修复并单独 commit。

## 2. 门禁基线（每批次提交前必须全绿）

| 门禁                         | 命令                                | 基线                                                                                    |
| ---------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| i18n zh/en key 对等 + 无兜底 | `node scripts/check-i18n.mjs`       | 通过                                                                                    |
| renderer TSC                 | `cd renderer && npx tsc --noEmit`   | 222 个错误，全部位于测试文件（`__tests__`/`.test.`/`.spec.`），即非测试错误 0；不得新增 |
| main TSC                     | `npx tsc --noEmit -p tsconfig.json` | `main/` 开头错误 95 个（全量 614，含根 tsconfig 解析 renderer 别名的噪音）；不得新增    |

## 3. 已完成批次（1-12）

对应报告第 8 章三阶段 + 第 11 章版本计划。所有 commit 均在 `feat/resource-hub` 分支。

### Phase 1 信任修复（批次 1-3）—— P0 全部 10 项 + P1#13/#22/#23

| 批次 | 内容                                                                                                                                                                                                                          | 关键 commit                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1    | 任务执行语义重构：按工程队列、真取消/暂停（ffmpeg kill + 翻译批边界中断 + 阶段边界检查）、日志按工程过滤、取消中行态、完成横幅守卫（P0#1/#2/#3）                                                                              | a18d0c4 457b135 6e0c119 8a81b34 c7da8a1 bebd0e3 334e8c3 |
| 2    | 校对安全网：flush+dirty 跟踪、.bak 滚动备份、退出守卫+标记完成隐含保存（P0#5/#6、P1#18 主体）；合成页清除独立+提示准确+默认输出路径（P0#4、P1#13）；暗色失败行（P0#7）                                                        | 3a22b4f 6b68067 86b2400 90f3988 5893cb1                 |
| 3    | File.path→webUtils 迁移（P0#8）；ProvidersTab 首项选中修复（P0#9）；macOS 关窗保活+Dock 进度（P0#10、P1#34 部分）；保存降噪 debounce+静默成功（P1#23）；useConfirmOrUndo 统一危险操作（P1#22）；编辑态隐藏顶层切换器（P1#14） | bc6a812 54eb5ca 5d05180 5c64e6e 33f1db7 3018661         |

### Phase 2 编辑器专业化（批次 4-8）—— P1#11/#12/#15/#20/#28/#29/#31 等

| 批次 | 内容                                                                                                                                                                      | 关键 commit                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 4    | 快捷键体系：useHotkeys hook、速查面板（帮助菜单+?）、编辑器 7 条接线+底部提示条、全局 Cmd+,/Cmd+O、任务页 Cmd+Enter（P1#11）                                              | 9d75c47 4203d87 a49f39f a80b104         |
| 5    | 命令模式撤销（行级 diff，覆盖逐字编辑）；虚拟化紧凑列表+当前行展开编辑；播放联动二分索引（P1#12、P0#5 根因）                                                              | eedde96 48ec8e3 fde366c a4fd3c0         |
| 6    | 时间轴行内编辑（邻行钳制校验+可撤销，P1#31）；批量 AI 优化可取消（P1#29）；失败集中处理：仅失败筛选+批量重翻 IPC+进度（P1#15）                                            | 6505ef1 ec744c3 af4c86d 4ee76fe         |
| 7    | 合成页四件套：真实字幕预览随播放（P1#28）、ffmpeg 烧录可取消（P1#29）、软字幕 mkv 封装选项、中文默认字体+完成态复位（P1#20）                                              | 1ab184b 7df9c51 2171d23 814a9b4 ff9575b |
| 8    | 任务页四守卫（导入去重 P1#25、运行中禁用 P1#26、不翻译选项 P1#27、多文件横幅 P1#24）；列表多选合并（Shift+点选）；搜索替换强化（逐条确认/定位/大小写）；AI 优化纯转写模式 | 127062d 7dc704e 3cb09f9 f999869         |

### Phase 3 品牌与一致性（批次 9-12）—— P1#16/#17/#19/#21/#30/#32/#33/#34/#36 等

| 批次 | 内容                                                                                                                                                                                                                                                                     | 关键 commit                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 9    | 设计 token：indigo 品牌主色+四态状态色 token+tailwind 扩展（P1#33）；硬编码状态色全量替换为语义 token（P1#16）；危险操作降权（P1#17）；暗色破损修复+紧凑 hack 移除+logo 品牌底                                                                                           | 7fb8051 9b30fef 8f84b69 db5bdad                                  |
| 10   | 术语表全量替换（转写/GPU 加速/合成到视频，P1#32）；200 死键清理+硬编码文案 i18n 化；移除 260 处 `t() \|\| '兜底'`；check-i18n 门禁脚本固化（4.5）                                                                                                                        | 1d698a3 c783d59 d03d0d0 a10fa99（修复：1b28915 f480548 67bc332） |
| 11   | PageHeader/EmptyState 两模板六页收敛+侧边栏命名统一（P1#21）；应用菜单本地化（P1#34）；更新提示去重+手动检查+版本徽章（6.8.1/6.8.2）；Mac 正向加速徽章+CPU 中性文案（4.6.7）；设置页关于卡+模型路径收敛到资源中心+删 GPU 过渡卡（6.6.5）；最近任务查看全部+搜索（4.1.6） | 5448459 0ee9a57 3595839 8ebfa8c b603e7f                          |
| 12   | 可达性兜底：hover-only 控件 focus-visible+aria-label（4.3）；任务行文件大小/媒体时长/剩约 ETA（P1#36）；服务商三组分段+推荐卡+搜索+测试语向跟随配置+结果常驻卡（P1#30、6.5.10）；SSR window 守卫修复                                                                     | 18a5583 3a80c91 beb9f0a 9cbe1ed                                  |

### 期间确认事项（避免重复排查）

- P1#19 模型推荐双信源：`getRecommendedCategory`（renderer/lib/utils）已是唯一信源，无需再改。
- 阶段链当前态强调（loading=primary+spinner）已存在，P1#36 只补了元信息与 ETA。
- 「不翻译」选项后续在翻译类任务里移除并加服务商缺失守卫（1b28915），属用户实测反馈的修正。

## 4. 剩余未完成项

### P1 残留（1 项）

- **#35 工程状态误判历史工程**：`renderer/pages/[locale]/home.tsx` 的 `getProjectStatus` 仍用当前全局 `userConfig` 推导历史工程阶段（6.1.6）。应改用工程自身保存的配置（project 上已持久化 taskType 等字段）。

### P2 功能补全

- 引导第 4 步「示例任务」：内置 10 秒示例音频一键跑通全流程（6.7.1，aha moment 前置）。
- 帮助菜单「常见问题」：mac「已损坏」修复、CUDA 闪退换版本（6.7.2，README 有但应用内没有）。
- 模型下载进度全局可见 pill（顶栏/侧边栏，6.7.3）。
- VAD 预设档位（保守/标准/激进，6.6.1）+「0」语义说明（6.6.2）。
- 参数编辑器简化（6.5.12）。
- 模型下载失败 UI 提示（6.5.4）；导入字幕语向检测（6.3.18）。

### P2 打磨/解释（需先复核现状再做）

- ModelsTab：95%/90% 匹配度解释、评分圆点图例、复制图标 tooltip、emoji 档位图标替换（6.5.1-3、5.5）。
- 黄色警告语气校准（加速 Tab，6.5.14）；资源中心概览整卡可点（6.5.18-19）。
- 「完成率」语义（6.3.15）、格式提示失真（4.4）——可能已被前批次消化，做之前先核对。
- 「当前字幕」冗余卡（6.3.14）、绿色文件卡配色（5.3）——B5/B9 可能已覆盖，先核对。

### 技术债

- whisper addon native abort：B1 已做队列级取消 + ffmpeg kill + 翻译中断，转写推理中途中断需改 native addon（报告 11.5 风险表的挂账项）。
- `webSecurity:false` 迁移自定义协议（4.6.5）。
- Windows 路径兼容清理（6.3.17）；dev 模拟数据混入真实 gpuName（6.5.13）。

### 对外形象（需用户参与）

- README/官网全套新截图 + IA 重构 before/after release note（5.7、6.8.4）。
- v2.20+ backlog：托盘常驻/防睡眠、日语界面、官网文档体系。

## 5. 下一批次候选（已向用户提出，待选择）

- A. 新手旅程闭环：引导示例任务 + FAQ + 下载进度 pill（用户价值最高）。
- B. 零碎收尾打包：P1#35 + ModelsTab 打磨 + VAD 预设。
- C. 技术债：native abort（难度最高，动 whisper.cpp addon）+ webSecurity 迁移。
- D. 对外形象：README 截图与 release note（需实机截图配合）。

## 6. 关键文件索引

- 报告原文：`docs/UX_ANALYSIS_REPORT.md`（问题编号、线框、验收标准都在这里）。
- 各批次设计文档：`docs/superpowers/specs/2026-06-12-*-design.md`；实施计划：`docs/superpowers/plans/2026-06-12-*.md`。
- i18n 门禁脚本：`scripts/check-i18n.mjs`（`node scripts/check-i18n.mjs`）。
- 设计 token：`renderer/styles/globals.css`（品牌色/状态色 CSS 变量）+ `renderer/tailwind.config.js`（success/warning/info 等扩展）。
- 任务执行链：`main/helpers/taskProcessor.ts`（按工程队列）、`main/helpers/taskContext.ts`（取消上下文）、`main/helpers/audioProcessor.ts`（ffmpeg 注册表）。
- 编辑器核心：`renderer/hooks/useSubtitleHistory.ts`（命令撤销）、`renderer/components/proofread/SubtitleList.tsx`（虚拟化）、`renderer/hooks/useHotkeys.ts`。
- 共享 UI 模板：`renderer/components/PageHeader.tsx`、`renderer/components/EmptyState.tsx`。
- 服务商：`types/provider.ts`（group 字段）、`renderer/components/resources/ProvidersTab.tsx`、`renderer/lib/providerUtils.ts`。

## 7. 并行工作流说明（同分支上的另一条线）

本分支早期还有一条「资源中心重构」线（`RESOURCE_HUB_REDESIGN_PLAN.md`、`docs/superpowers/plans/2026-06-11-*.md`、`.superpowers/brainstorm/` 的 HTML 视觉稿、`resources/preview/` 截图），是 UX 报告成文前的铺垫工作，其成果已体现在当前代码与报告中；续作以本文档第 4-5 节为准。
