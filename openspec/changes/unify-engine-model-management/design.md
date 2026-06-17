## Context

当前转写引擎是**全局单例** `settings.transcriptionEngine`，由 `resolveTranscriptionEngine()` 解析；任务执行链路 `taskProcessor → fileProcessor → routeTranscription → getActiveEngineAdapter()` 全部读这个全局值，任务本身只携带 `model`（一个名字）。资源中心把「引擎」与「模型」拆成两个 Tab：

- `EnginesTab.tsx`：5 张卡片（builtin / fasterWhisper / funasr / localCli + Python 基座），每张卡有「设为当前」+「管理→Drawer」，Drawer 内是各引擎面板（`engines/panels/*`）。
- `ModelsTab.tsx`：顶部 `EngineContextBar` 显示"当前引擎"，**模型清单完全由全局引擎驱动**（builtin→ggml 档位、fasterWhisper→ct2、funasr→FunasrModelSection、localCli→提示）。

已确认的关键事实：模型下载链路（`downloadModel` / `downloadCt2Model` / `downloadFunasrModel`）**不依赖引擎运行时包**——`isEnginePackageInstalled` 仅在转写运行与"设为当前"处校验。引擎适配器接口 `TranscriptionEngineAdapter`（`id/requiresRuntime/pyEngineId/isAvailable/transcribe/cancelActive/prewarm?`）已是按引擎自包含的；`TranscribeContext` 已携带 `formData` 端到端流入 `routeTranscription`。

约束：无老用户（可零迁移地删除全局字段）；不改模型下载/翻译/加速底层 IPC；遵循"只做最小必要后端改动"。

## Goals / Non-Goals

**Goals:**

- 引擎与模型在单一「主从双栏」视图内统一管理，零弹窗；资源中心 5→4 Tab。
- 引擎选择改为**逐任务**：任务携带引擎，后端按任务引擎执行，移除全局单例与"启用/设为当前"。
- 模型下载与引擎安装彻底解耦（未装引擎也能先下模型）。
- 默认引擎 = 上次使用（初次 builtin）；就绪判断改为跨引擎口径。
- 删除顶栏引擎徽章；Python 基座更新迁往设置页。

**Non-Goals:**

- 不做"部分引擎并行、部分串行"的混合引擎调度（本期按最受限引擎钳制）。
- 不改模型下载器、翻译服务、加速包管理的底层实现。
- 不引入在线模型市场，不改各引擎模型的清单来源（仍是静态清单 + 已装探测）。
- 不为旧 `transcriptionEngine` 字段做数据迁移（直接删除）。

## Decisions

### D1：引擎经 `formData.transcriptionEngine` 透传，路由按任务引擎解析

`TranscribeContext.formData` 已端到端流入 `routeTranscription`。在 `formData` 中加入 `transcriptionEngine`，`routeTranscription` 改为 `getEngineAdapter(formData.transcriptionEngine) ?? builtinEngineAdapter`，不再调用 `getActiveEngineAdapter()`。`getActiveEngineAdapter()`（读全局）随之退役。

- **为何**：复用既有 formData 通道，主进程改动面最小，且天然按任务隔离。
- **备选**：给 `TranscribeContext` 加显式 `engine` 字段或新参数 —— 需要在多层调用里显式穿参，比复用 formData 噪声更大。

### D2：任务时用「引擎 ▸ 模型」分组下拉，选项值编码 (引擎,模型)

`Models.tsx` 从"按全局引擎过滤的扁平下拉"改为"按引擎分组的下拉"，每组列出该引擎已安装模型；选项 value 编码 `engine + model`。`tasks/[type].tsx` 的默认选择逻辑据此回填 form 的 `transcriptionEngine` 与 `model`。

- **为何**：模型名在引擎间有歧义（如 `large-v3` 同时存在于 ggml/ct2），(引擎,模型) 二元组消除歧义；单一控件比"引擎下拉 + 模型下拉"更省位，且天然杜绝非法组合。
- **备选**：独立引擎下拉 + 联动模型下拉 —— 多一个控件、需处理联动空态，交互更重。

### D3：默认值取"上次使用"（**全局**，engine+model 作为一个整体），删除全局 `transcriptionEngine`

新增轻量设置字段 `lastUsedTranscription: { engine, model }`，**全局单条**，(引擎, 模型) 作为一个整体记录；任务成功配置/执行后更新；任务页初始默认读它，缺省回退 builtin + 该引擎首个可用模型。移除 `settings.transcriptionEngine` 及 `useLocalWhisper` 的运行时语义、`set-transcription-engine` 的"设为当前"语义与 `get-transcription-engine`。

- **为何（UX）**：引擎偏好由硬件 + 语言决定，是用户稳定偏好，几乎不随任务类型变；全局记忆符合"应用记得我上次用什么转写"的直觉，且仍是默认值、任务里随时可在同一下拉覆盖。
- **为何 engine+model 一起记**：若"引擎记全局、模型记任务级"会失配（全局引擎=funasr 但任务级模型=ggml），故二者必须作为一个整体。
- **备选**：① 任务级（按 task-type）记忆 —— 切换任务类型会"忘记"引擎，制造惊讶，否决；② 复用 `transcriptionEngine` 作默认 —— 用户要求删除，否决。

### D4：主从双栏，状态来自左栏选中（本地 UI 态），非全局

新建统一组件（合并 `EnginesTab` 的面板与 `ModelsTab` 的清单）：左栏引擎列表 + 状态点（就绪/未装/需配置），右栏 = 选中引擎的运行时管理（安装/修复/升级/卸载/参数）+ 模型清单（下载/删除/导入/路径/源/搜索/仅已装）。选中态是组件本地 state，不写全局。各引擎面板 `engines/panels/*` 与模型清单子树尽量平移复用。

```
┌ 引擎与模型 (主从双栏) ──────────────────────────────────────┐
│ ┌─────────────┐ ┌──────────────────────────────────────┐ │
│ │● Builtin     │ │ Builtin·whisper.cpp            [就绪] │ │
│ │○ FasterWhisper│ │ 运行时: 内置无需下载                  │ │
│ │● FunASR      │ │ 参数: 设备[auto] 计算[auto]          │ │
│ │○ LocalCLI    │ │ ──────────────────────────────────── │ │
│ └─────────────┘ │ 模型 [搜索][仅已装][导入] ▸快速▸均衡… │ │
│  状态点,无启用    │ (LocalCLI 右栏=命令配置,无模型清单)    │ │
│                 └──────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

- **备选**：手风琴（单列可展开）/ 顶部分段选择器 —— 用户选定主从双栏。

### D5：混合引擎队列按"最受限引擎"钳制并发

`taskProcessor` 的并发计算从 `getActiveEngineAdapter().id` 改为：遍历当前可运行任务集，按各自 `formData.transcriptionEngine` 求引擎；只要含 faster-whisper / funasr，`effectiveMax = 1`。

- **为何**：单次提交共用一个引擎，混合仅出现在跨提交排队；保守钳制即正确，避免共享 sidecar/显存争用。
- **备选**：真正的混合调度（builtin 并行 + fw 串行）—— 复杂度高，本期不做。

### D6：跨引擎就绪判断 + sidecar 预热按任务引擎

`hasModelsForEngine(单引擎)` 增加一个跨引擎入口"任意引擎有任意模型即就绪"，用于 `Layout` 新手引导、`OverviewTab`、`InlineConfigBar` 的"去下载模型"判断。`taskProcessor` 批次开始时的预热从"活动适配器"改为"任务所带引擎的适配器"（`requiresRuntime && pyEngineId` 才启 sidecar）。

### D7：Python 基座迁往设置页；引擎视图去基座卡

`BaseRuntimePanel` 的"检查更新"迁入设置页（新增一处入口）。统一引擎视图的左栏不再含"Python 基座"条目。基座底层下载/校验逻辑不变。

### D8：Tab 收敛 + 深链接归一（规范键 `engines`）

`resources.tsx` 的 `RESOURCE_TABS` 以 **`engines`** 作为统一 Tab 的规范键（主从双栏主轴是引擎，模型为其下二级，`engines` 最贴切），`models` 作为别名解析/重定向到 `engines`。`?tab=engines` / `?tab=models` 都落到统一 Tab。受影响的跳转：`Layout` 顶栏（删引擎徽章）、`InlineConfigBar` 的"去下载模型"链接（改指 `engines`）、`OverviewTab` 的"管理"入口、侧栏下载 pill（改指 `engines`）。

- **备选**：保留 `models` 为规范键或引入新键 `engine-model` —— 前者语义已偏（不止模型），后者无谓增加新键；按最佳实践取最贴切且兼容旧链的 `engines`。

### D9：localCli 在分组选择器中的呈现

localCli 作为独立分组出现，其模型项 = 内置规范模型名清单（tiny…large-v3，即现 `getSelectableModelsForEngine` 对 localCli 的返回），保证 `${whisperModel}` 占位符替换可用、且引擎可被直接选中。

- **为何**：`transcribeLocalCli` 用 `whisperCommand` 模板的 `${whisperModel}` 把所选模型名插进命令——模型名是功能性的；给规范名让替换工作，模板未用该占位符时选择仅为无害装饰。
- **备选**：单个中性名（如"自备模型"）—— 会破坏依赖 `${whisperModel}` 的模板，否决。

### D10：模型「下载」与引擎「安装」解耦，但任务「选择」按运行时是否就绪过滤

模型下载在「引擎与模型」管理页与引擎安装解耦（未装引擎也能先下模型）；但任务页的「引擎 ▸ 模型」选择器只列出**引擎运行时已安装**的模型——只下了模型却没装对应引擎不可转写，列出来只会让用户选中后开跑即报错。实现上 `getEngineModelGroups` 对 faster-whisper 要求 `pythonEngineStatus.state==='ready'`、对 funasr 要求 `funasrEngineInstalled`，builtin 内置运行时始终通过；跨引擎就绪判断 `hasAnyModelAnyEngine` 同口径，保证"全景/新手引导说就绪"与"任务页可选"一致。

- **为何**：下载早、决定晚（解耦）对探索友好；但执行前必须可运行（过滤）才不误导。两个动作分属不同页面、不同时机，门禁口径据此分离。
- **备选**：任务页也列出未装引擎的模型并在选中时报错 —— 把错误推迟到运行期，体验更差，否决。

### D11：UI 收尾（管理页文案/图标）

- 引擎管理页右栏：funasr 模型区移除"引擎运行时未安装，请先在引擎页下载"横幅（用户已在引擎页内，提示冗余）；builtin 面板移除"语音模型"跳转按钮（模型清单就在同屏下方）。
- 左栏引擎列表改用各引擎品牌化彩色图标（`EngineIcon`：builtin 声波芯片 / fasterWhisper 闪电 / funasr 橙色声波 / localCli 终端），替代通用单色图标，便于一眼区分。

### D12：引擎面板交互统一（卸载二次确认 / funasr 检查更新 / localCli 启用开关 + 多行命令）

- **卸载二次确认**：faster-whisper 与 funasr 的「卸载」不再单独占行，内联到已安装信息行（与版本号/检查更新同排，`ml-auto` 右对齐）；点击弹出 `AlertDialog` 二次确认（破坏性动作用 `bg-destructive` 主按钮）。新增 i18n `engines.{fasterWhisper,funasr}.uninstallConfirm`。
- **funasr 检查更新对齐 faster-whisper**：funasr 运行库随 App 固定发布，无远端 manifest；新增主进程 IPC `check-sherpa-lib-update`，比较「已装 `SherpaLibStatus.version`」与「App 内置 `SHERPA_VERSION`」，不一致即 `hasUpdate`。面板已安装态统一为「版本号 + （有更新→升级 / 无更新→检查更新）+ 卸载」，升级复用 `download-sherpa-lib`（重下覆盖到 App 预期版本），安装/升级共用一个确认弹窗（按 `installed` 切换文案/图标）。复用既有 i18n（`installedVersion/checkUpdate/checking/upToDate/updateAvailable/upgrade/upgradeConfirm/checkFailed`）。
- **localCli 启用开关**：管理页面板顶部加 `Switch`（沿用 `settings.useLocalWhisper`）。开启后任务页「引擎 ▸ 模型」分组选择器才会列出本地命令行（`includeLocalCli = useLocalWhisper`，与任务页同源）；左栏就绪点亦需「启用且已配置命令」才转绿。新增 i18n `engines.localCli.enable/enableHint`。
  - **为何**：D9 已定 localCli 以独立分组进选择器，但需要一个显式开关让用户决定是否暴露；`useLocalWhisper` 是既有且语义贴合的字段，复用它即可，无需引入新字段。
- **localCli 命令多行**：命令输入由单行 `Input` 改为 `Textarea`（`rows={4}`，等宽字体），自备命令常较长且含多变量占位符，多行更易读写。

## Risks / Trade-offs

- **混合引擎队列被过度串行化** → 保守钳为 1 只在队列含 fw/funasr 时生效；纯 builtin 队列仍按用户并发设置，影响可接受。
- **删除全局字段牵动多处读取点** → 以 grep 驱动清扫 `transcriptionEngine` / `getActiveEngineAdapter` / `useLocalWhisper` 全部引用；无老用户故无运行期迁移风险。
- **默认 (引擎,模型) 回填出错导致空模型开跑** → 默认逻辑必须校验 (引擎,模型) 在分组选项中存在，缺失则回退到该引擎首个可用模型或触发"去下载"。
- **选用未就绪引擎的任务** → `routeTranscription` 仍走 `adapter.isAvailable()` 守卫，不就绪则明确报错，不静默回退。
- **大组件合并引入回归** → 各引擎面板与模型清单子树尽量"平移而非重写"，分原子提交逐 Tab 验证。

## Migration Plan

- 无数据迁移（删除 `settings.transcriptionEngine`，无老用户）。
- 实施顺序：先后端引擎透传与默认值字段（保证任务可按引擎跑）→ 任务页分组选择器 → 统一管理视图（合并）→ 删除全局指示/基座迁移/Tab 收敛 → i18n 清扫 → typecheck + build + 冒烟。
- 回滚：分支级回退（改动集中在 `feat/*` 分支）。

## Open Questions

（原 3 个待定项已拍板，见 D3 / D9 / D8）

- "上次使用"落点 → **全局单条 `settings.lastUsedTranscription`，engine+model 一起记**（D3）。
- localCli 进分组选择器 → **是，独立分组列内置模型名，保 `${whisperModel}` 替换**（D9）。
- 统一 Tab key → **规范键 `engines`，`models` 别名重定向**（D8）。
