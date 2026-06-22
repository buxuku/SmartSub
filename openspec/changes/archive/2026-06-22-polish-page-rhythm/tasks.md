## 1. 契约固化与基线核对

- [x] 1.1 以翻译页 `ProvidersTab` 为基准样板，记录其六杠杆落点（详情头 `text-xl/2xl`+`border-b`、`label-caps` 组标签、`bg-primary/10`+`ring-primary/20` 选中态、`rounded-lg`/`md`、纵向节奏）作为对照清单
- [x] 1.2 核对 `globals.css`/`tailwind.config.js` 既有工具类（`label-caps`/`shadow-sunken`/`font-mono`/`--radius`）齐备，确认本次无需新增 token/字体/颜色
- [x] 1.3 建立「逐页对照表」（页面 × 六杠杆 × 状态），作为走查与验收依据

## 2. 引擎页对齐翻译页（③ 详情头 + ② 分区）

- [x] 2.1 `EngineModelTab.tsx` 右栏详情头：标题由 `text-base font-semibold`（`:633`）提升为 `text-lg`，与翻译页量级一致
- [x] 2.2 `EngineModelTab.tsx` 详情头行下补 `border-b pb-3` 分隔，与下方 `ModelLibrarySection` 的 `border-t pt-4` 形成对称分区
- [x] 2.3 引擎页内分区标题核对：`ModelLibrarySection` 档位头已是 Tier H（`text-sm font-semibold`），左栏列表无标题处不新增任何标签（内容冻结）——无需改动
- [x] 2.4 自查：引擎页与翻译页详情头均「明显强于正文 + border-b 分隔」，选中态一致（`bg-primary/10`+`ring-primary/20`），节奏对齐

## 3. 分区标题双层归一（②）

- [x] 3.1 面板/列内组标签 Tier S（`label-caps`）：翻译页「免费层/AI/MT」「推荐」已是；设置页为 `CardTitle`+`IconChip` 卡标题（自成一套且各卡一致），不属「面板内组标签」，保持不动
- [x] 3.2 页级小节标题 Tier H（`text-sm font-semibold`）：`home.tsx`「最近任务」（`:354`）已是该写法（带 muted，契约允许）；`ModelLibrarySection` 档位头亦为 `text-sm font-semibold` —— 均已合规
- [x] 3.3 自查：全仓分区标题仅余 Tier S（`label-caps`）/ Tier H（`text-sm font-semibold`）两种写法，无新增标题文字（内容冻结）

## 4. 圆角与纵向节奏收口（④⑥）

- [x] 4.1 审计并修正 `rounded-xl`→`rounded-lg`（hub 范围 5 处）：`ModelLibrarySection:189`(推荐卡)、`WorkItemList:47`(列表容器)、`recent-tasks:246`(no-match)、`EmptyState:24`(空态框)、`OnboardingDialog:76`(图标 chip)；`tasks/[type].tsx:618` 属工作面 → 留 Phase 6
- [x] 4.2 `home.tsx` `space-y-8`（`:237`）→ `space-y-6`，向枢纽页基线收敛；段内仍 `space-y-3`
- [x] 4.3 保留 home/recent 的 `max-w-4xl` + `px-6 py-10` 阅读型差异，仅对齐区块间距
- [x] 4.4 自查：各 hub 页圆角统一 `rounded-lg`、纵向节奏符合 D1/D4 刻度（lint 通过）

## 5. 卡片/面板框回声（⑤）

- [x] 5.1 主从列表项选中态一致（引擎/翻译页均 `bg-primary/10 ring-1 ring-inset ring-primary/20`，5.4 已统一）；`WorkItemList` 列表容器 `rounded-lg`+`border`+`divide-y` 成形；静息态描边判定为「会显杂乱」，不强加
- [ ] 5.2 运行时面板（builtin/fasterWhisper/localCli/sherpa）裸露分区补轻分隔 —— 需运行态核对，并入 Phase 6 工作面走查一起做
- [x] 5.3 自查：卡片/列表/详情头分区靠描边/分隔成形（`Card` 1px + 列表 `divide-y` + 详情头 `border-b`），非纯空白堆叠

## 6. 高密度工作面走查（tasks/proofread，最后最谨慎）

- [x] 6.1 `tasks/[type].tsx`：工作区 `rounded-xl`→`rounded-lg`（`:618`，全仓最后一个离群点）。自定义头刻意保持紧凑无 `border-b`（下方 `InlineConfigBar` 已是 `rounded-lg border` 描边面板，再加分隔会"双线"打架）；`gap-3` 高密度节奏按 Requirement 8 保留；视图切换组 `rounded-md` 属小控件正确量级，不动
- [x] 6.2 `proofread.tsx`/`ProofreadEditor`：核对后确认已合规 —— 阶段头 sticky `border-b`（=契约详情头）、底部快捷键条 `border-t`、`grid gap-2/4` 高密度刻意，无 `rounded-xl`，无需改动（内容冻结）
- [ ] 6.3 逐屏运行态核对（`npm run dev`）：tasks 列表/网格不溢出、ProofreadEditor 双栏不挤压、引擎页运行时面板（builtin/fasterWhisper/localCli/sherpa，原 5.2）分隔在深/浅色下成形
- [x] 6.4 `subtitleMerge`（字幕合并，原漏网 live 页）②分区标题归一：样式卡内三处同级组标签从混用（`text-sm font-medium` / `text-xs font-medium muted`）统一为 `label-caps`（Tier S），对齐 `ProvidersTab` oracle（静态标签 + `CollapsibleTrigger` 内 span 均用 label-caps）。涉及 `StylePresets:26`、`SubtitleMergePanel:141`、`AdvancedStyleSettings:50`；其余（CardTitle 面板头、表单字段 Label、选项卡标题、进度值）非组标签，保持不动。圆角/卡片框/节奏本就合规

## 7. 验证

- [x] 7.1 `openspec validate polish-page-rhythm --strict` 通过（"Change 'polish-page-rhythm' is valid"）
- [ ] 7.2 运行态走查（`yarn dev`）：renderer 已 `Ready`、`/[locale]/home` 编译通过、`GET /zh/home 200`、Electron 已启动 → 改动可安全运行；六杠杆逐页 + 深/浅色「肉眼」核对需在 **Electron 窗口**进行（纯浏览器走查被既有架构阻断：`LogDialog.tsx:28` 未做 `window.ipc?.` 守卫，无 preload 时 Next 报运行时错误遮罩，与本次改动无关）
- [x] 7.3 内容冻结核验：`git diff --word-diff` 显示 8 个改动文件的**每一处** hunk 均为 className 字符串级改动（圆角/字号/分隔/选中态/mono/节奏），无文案/i18n key/JSX 结构/props/数据/IPC/逻辑变更
- [ ] 7.4 功能回归抽查：因全部为 className-only，逻辑/IPC/事件链未触碰 → 行为构造性不变；引擎选择/模型下载、翻译商配置、任务运行、校对编辑等关键路径仍建议在 Electron 窗口抽查确认
