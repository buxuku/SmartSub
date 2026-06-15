# 任务体验批次设计（引擎检测反馈 · 默认模型 · 软字幕标识 · 列表视图 · VAD 开关）

> 状态：已评审（待写实现计划）
> 日期：2026-06-15
> 范围：faster-whisper 引擎安装反馈 · 任务默认模型 · 内封软字幕标识 · 任务列表视图类型 · VAD 开关入高级选项
> 关联：`renderer/components/resources/EnginesTab.tsx`、`renderer/components/tasks/*`、`main/helpers/fileProcessor.ts`、`main/helpers/engines/fasterWhisperEngine.ts`、`main/background.ts`（media://）

---

## 1. 背景与目标

本批次集中处理 5 个相互独立、但都围绕「任务页可用性」的体验问题。各主题可拆分实现、互不阻塞，统一一个设计文档与一个实现计划。

| #   | 主题                   | 一句话目标                                                            |
| --- | ---------------------- | --------------------------------------------------------------------- |
| T1  | 引擎下载后的「检测中」 | 下载完成到「可使用」之间给出明确等待反馈，并禁止此期间重复点下载      |
| T2  | 无模型默认选第一个     | 已装模型但未选时自动选第一个；起跑前兜底校验，避免空模型直接报错      |
| T3  | 软字幕直提标识         | 走内封软字幕直提的文件，在任务行展示图标 + hover 提示                 |
| T4  | 任务列表视图类型       | 新增「列表 / 网格」视图切换；网格视频显示缩略图、其它类型显示大图标   |
| T5  | VAD 开关入高级选项     | 把 VAD 开关放进任务高级选项并加说明；为 faster-whisper 启用词级时间戳 |

### 1.1 用户确认的关键决策

| 决策点              | 选择                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| T3 标识形态         | 图标 only（文件名后）+ hover 提示；图标用 lucide `Captions`（CC）               |
| T4 缩略图实现       | 复用现有 `media://` 协议 + `<video preload="metadata">` 作静态封面（零 ffmpeg） |
| T4 解不了的容器兜底 | 仅类型大图标兜底（Option 1，本期零 ffmpeg）                                     |
| T4 默认视图         | 默认「列表」，记住用户上次选择                                                  |
| T4 视图切换作用域   | 全局统一（所有任务页共享一个视图模式）                                          |
| T5 VAD 开关位置     | 任务「高级选项」（AdvancedSheet）的「识别」区，仅媒体任务                       |
| T5 VAD 作用域       | B1 全局透传（开关直接读/写全局 `settings.useVAD`）                              |
| T5 VAD 默认值       | 默认「开」（与现状一致）                                                        |
| T5 word_timestamps  | 仅 faster-whisper 本期启用（近零成本修时间戳）；builtin 维持现状                |

### 1.2 非目标（本期不做）

- 不为 builtin（whisper.cpp）启用词级时间戳（依赖外部 `addon.node` 改造，单列后续）。
- 不做 ffmpeg 抽帧缩略图兜底（mkv/ts/hevc 等解不了的容器先用类型图标；后续可作增强）。
- 不做 VAD 的逐任务覆盖（B2）；详细 VAD 参数与三档预设仍只在「设置」页。
- 不做基于 `words[]` 的词级字幕重切分（本期只用 `word_timestamps` 修正段级时间戳）。

### 1.3 范围与门禁

- 一个设计文档 + 一个实现计划，按主题拆 task。
- 每个代码任务门禁：`npx tsc -p tsconfig.json`（退出 0）、`npm run test:engines`（末行 `0 failed`）、`node scripts/check-i18n.mjs`（zh/en 键对等）。

---

## 2. T1 · 引擎下载后的「检测中」反馈

### 2.1 现状与根因

`EnginesTab.tsx` 监听 `py-engine-download-progress`，`completed` 分支当前如下：

```144:149:renderer/components/resources/EnginesTab.tsx
        if (_progress.status === 'completed') {
          // 下载完成后引擎还需校验/冷启动，期间给出明确状态，避免用户以为卡住没反应
          setVerifying(true);
          // 升级/安装成功，清除"有更新"标记
          setUpdateInfo(null);
          refresh().finally(() => setVerifying(false));
```

- `completed` 分支：`setVerifying(true)` 后 `refresh().finally(() => setVerifying(false))`。`refresh()` 只读 `get-engine-status`，而 faster-whisper 的 `isAvailable()` 仅判断 manifest 是否落盘（不做冷启动 ping），因此 `refresh()` 很快返回、`verifying` 几乎立即结束。
- 下载按钮显隐条件为 `!fasterInstalled && !isDownloading && !fasterBroken`，**未含 `verifying`**。在「下载完成→真正可用」的空档里，按钮重新出现且可被再次点击。
- 真正的冷启动校验（PyInstaller 首帧加载）此刻并未发生，用户看到的是「下载完了但界面没明显变化、还能再点下载」。

### 2.2 方案

1. **把「检测中」做成真实阶段**：`completed` 后调用已存在的 IPC `python-engine:ping`（内部 `getPythonRuntimeManager().ensureStarted()` 做冷启动校验，见下），`verifying` 持续到它返回；成功 → `refresh()` 转 ready，失败 → 进入 broken/修复态并展示 `message`。

```195:204:main/helpers/ipcEngineHandlers.ts
  ipcMain.handle('python-engine:ping', async () => {
    try {
      const manager = getPythonRuntimeManager();
      await manager.ensureStarted();
      return { success: true };
    } catch (error) {
      logMessage(`Python engine ping failed: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });
```

2. **空档期禁用入口**：下载/修复/设为当前等按钮在 `isDownloading || verifying` 时隐藏或禁用（给现有显隐条件补 `!verifying`）。
3. **明确文案**：徽章/面板显示「正在检测引擎可用性…」（已存在 `engines.fasterWhisper.verifying` 键，可复用/补充说明）。

### 2.3 边界

- `python-engine:ping` 冷启动超时（`START_PING_TIMEOUT_MS = 60s`，含一次重试）：超时即按校验失败处理，转修复态，避免 verifying 永久挂起。
- 组件卸载时清理 verifying 计时/订阅（沿用现有 useEffect 清理）。

### 2.4 受影响文件

- `renderer/components/resources/EnginesTab.tsx`：`completed` 分支改为 await `python-engine:ping`；按钮显隐补 `!verifying`；文案。
- i18n：`resources` 命名空间 verifying 相关文案（zh/en）。
- 主进程零改动（复用 `python-engine:ping`）。

---

## 3. T2 · 无模型默认选第一个 + 起跑兜底

### 3.1 现状

- `InlineConfigBar.tsx` 的模型选择绑定 `formData.model`，经 `Models.tsx` 渲染；`Models` 的可选项按引擎区分（builtin→`modelsInstalled`、fasterWhisper→`fasterWhisperModelsInstalled`、localCli→内置 `models`）。
- `useFormConfig` 只还原持久化的 `userConfig`，不会自动填模型。
- `TaskControls.handleTask` 仅校验「有文件」「翻译任务有有效服务商」，**不校验模型**；空模型可直接派发任务，下游可能报错。

### 3.2 方案

1. **自动选第一个**：当 `typeDef.needsModel` 且「当前引擎的已装模型列表」非空、且 `formData.model` 为空或不在该列表内时，`form.setValue('model', 列表第一个)`（按 `Models` 的取值约定用 `.toLowerCase()`）。引擎切换（`systemInfo.transcriptionEngine` / `useLocalWhisper` 变化）时复跑该逻辑，避免选中已不属于当前引擎的旧模型。
   - 实现位置：放 `renderer/pages/[locale]/tasks/[type].tsx` 的 effect（页面持有 `form`/`systemInfo`/引擎信息，职责更顺）。
   - 「当前引擎的已装模型」复用 `Models.getAvailableModels` 的同源逻辑；抽到 `renderer/lib/engineModels.ts`（已有 `hasModelsForEngine`）作 `getInstalledModelsForEngine(systemInfo, engine|useLocalWhisper)` 共享。
2. **起跑兜底**：`TaskControls.handleTask` 在文件/服务商校验之后增加模型校验——`typeDef.needsModel` 且无有效模型时 `toast.error`（含「去下载模型」指引）并 `return`，不进队列。

### 3.3 边界

- 无任何已装模型时：不自动选（保持 InlineConfigBar 现有「去下载模型」按钮分支），起跑兜底同样拦截。
- localCli 引擎：可选项为内置 `models` 列表（恒非空），自动选第一个即可。

### 3.4 受影响文件

- `renderer/pages/[locale]/tasks/[type].tsx`：自动选模型的 effect。
- `renderer/lib/engineModels.ts`：加 `getInstalledModelsForEngine`。
- `renderer/components/TaskControls.tsx`：起跑模型兜底校验。
- i18n：`home`/`tasks` 的「请选择模型 / 去下载模型」文案（zh/en）。

---

## 4. T3 · 软字幕直提标识

### 4.1 现状

内封软字幕直提（见 `2026-06-15-embedded-subtitle-extraction-design.md`）成功时，`fileProcessor.ts` 仅把 `extractAudio`/`extractSubtitle` 置为 done，文件对象上**无任何标记**区分「内封直提」与「ASR 听写」。

per-file 元数据的成熟模式已存在：`builtinEngine.ts` 通过 `taskFileChange` 携带 `whisperBackend`，经 `useIpcCommunication.handleFileChange` 的 `{ ...file, ...res }` 通用 merge 自动进入任务态；`TaskRowList` 据此渲染后端徽标。软字幕标识沿用同款模式。

### 4.2 方案

1. **主进程打标**：内封抽取成功分支的 `taskFileChange` 事件携带 `embeddedSubtitle: true`（与 `extractAudio: 'done'` / `extractSubtitle: 'done'` 同对象发送即可）。
2. **类型**：`types/types.ts` 的 `IFiles` 增 `embeddedSubtitle?: boolean`。
3. **渲染（列表视图）**：`TaskRowList` 文件名后，当 `file.embeddedSubtitle` 为真时渲染 lucide `Captions` 图标（icon-only）+ `Tooltip`：
   - zh：`内封软字幕直提（已跳过听写/ASR）`
   - en：`Extracted from embedded subtitles`
4. **渲染（网格视图）**：T4 的卡片封面左上角放同款角标（小尺寸）。

### 4.3 受影响文件

- `main/helpers/fileProcessor.ts`：内封成功分支的 `taskFileChange` 携带 `embeddedSubtitle: true`。
- `types/types.ts`：`IFiles.embeddedSubtitle?: boolean`。
- `renderer/components/tasks/TaskRowList.tsx`：文件名后图标 + Tooltip。
- `renderer/components/tasks/TaskGridList.tsx`（T4 新建）：卡片角标。
- i18n：`tasks` 命名空间 tooltip 文案（zh/en）。

---

## 5. T4 · 任务列表视图类型（列表 / 网格）

### 5.1 可行性与成本结论

- **零新依赖**：`ffmpeg-static`、`@tanstack/react-virtual` 已在依赖中；本期连 ffmpeg 都不用。
- **零主进程改动（缩略图侧）**：`main/background.ts` 已注册 `media://` 为 privileged scheme（`stream: true`）并 `registerFileProtocol('media', …)` 返回文件路径，**支持 ranged seeking**（`react-player` 已用它拖动播放）。因此网格卡片可直接用 `<video src="media://<encoded>#t=1" preload="metadata" muted>` 作静态封面，无需抽帧、缓存、IPC。
- **主要成本**：视图切换 + 卡片布局 + `<video>` 懒加载与解码失败兜底。

### 5.2 方案

1. **视图切换**：任务页头部加「列表 / 网格」切换按钮。视图模式**全局统一**、默认「列表」、记住上次选择。
   - 持久化：`settings.taskViewMode: 'list' | 'grid'`（新增一个 store 键，默认 `'list'`，经 `getSettings`/`setSettings` 读写）。选 settings 而非 localStorage：与其它偏好同源、跨重装更稳。
2. **网格卡片**：新增 `renderer/components/tasks/TaskGridList.tsx`。卡片 = 封面区 + 文件名 + 进度（条或环）+ 阶段/标识。进度、阶段状态、整体百分比复用 `stageUtils`（`getFileStages`/`getStageStatus`/`getFilePercent`）。删除/校对/打开文件夹等操作沿用 `TaskRowList` 行为。
3. **封面（缩略图）**：
   - 视频：`<video src="media://<encodeURIComponent(filePath)>#t=1" preload="metadata" muted>` 作静态封面（不加 controls、不 autoplay）。
   - 解码失败兜底：监听 `onerror`，或 `loadedmetadata` 后 `videoWidth === 0` → 切类型大图标（lucide `Film`/`Clapperboard`）。Chromium 解不了的容器（mkv/ts/hevc/avi 等）走此路径。
   - 音频：类型大图标（lucide `Music`/`FileAudio`）。
   - 字幕/其它：类型大图标（lucide `FileText`）。
4. **性能护栏**：仅渲染可见卡片的 `<video>`（`@tanstack/react-virtual` 或 `IntersectionObserver`），控制同时存在的 `<video>` 数量，避免大批量任务时解码器实例过多。

### 5.3 边界

- 文件缺失/损坏：`<video>` `onerror` → 类型图标兜底。
- 拖拽导入区、空状态：网格视图同样支持（沿用 `TaskRowList` 的空态/拖拽逻辑）。
- 网格与列表共享同一份 `files` 数据与 `stageUtils`，仅呈现不同。

### 5.4 受影响文件

- `renderer/pages/[locale]/tasks/[type].tsx`：视图切换按钮 + 持久化 + 条件渲染 `TaskRowList`/`TaskGridList`。
- `renderer/components/tasks/TaskGridList.tsx`（新建）。
- `renderer/components/tasks/TaskRowList.tsx`：共享 stageUtils（必要时抽公共子件）。
- `main/helpers/store/{types,index}.ts`：新增 `settings.taskViewMode`（默认 `'list'`）。
- i18n：`tasks` 的「列表 / 网格」切换文案（zh/en）。

---

## 6. T5 · VAD 开关入高级选项 + word_timestamps

### 6.1 现状

- VAD 是**全局设置**：`store.settings.useVAD`（默认 `true`），详细参数 + 三档预设在「设置」页（`settings.tsx`）。两个引擎都从 `store.get('settings')` 读 VAD（builtin 经 `getVadSettings`，faster-whisper 内联）。
- `formData`（model/语言/prompt/maxContext/saveAudio）是逐任务 + 粘性配置（`userConfig`）。
- faster-whisper 当前**未传** `word_timestamps`（py-engine 侧默认 `False`），故 #1119 的「段 end 顶到下一段 start」未被缓解。

### 6.2 关于时间戳准确性（依据 #1119 与官方文档）

- VAD 会先剔除非语音片段：通常更快、更省，并显著减少在静音/音乐处的**幻觉重复字幕**；faster-whisper 批量转写默认即开启 vad_filter。
- 代价：可能影响**时间戳精度**——开 VAD 后某段结束时间有时被拉到下一段开始（faster-whisper 已知行为，[issue #1119](https://github.com/SYSTRAN/faster-whisper/issues/1119)）。这本质是 Whisper 模型的时间戳局限，官方缓解手段是 `word_timestamps=True`（强制对齐到 ~10ms）。
- 默认取舍：保持**默认开**。理由：关闭后静音/音乐处的幻觉字幕比时间戳轻微偏差更刺眼、更难清理；开启更稳更快、与现状一致不折腾老用户；并通过下方 word_timestamps 进一步缓解时间戳问题，给需要严格对齐的用户留「关」的选项。

### 6.3 方案

1. **开关位置与作用域（B1 全局透传）**：`AdvancedSheet` 的「识别」区（`isMediaTask` 才显示）加一个 `Switch`：
   - 初值：组件打开时 `getSettings()` 读 `useVAD`（`!== false`）。
   - onChange：`setSettings({ useVAD })`（与设置页同一全局源；注明「全局设置」）。
   - 该开关**不进 react-hook-form**（它是全局设置而非 formData），独立读写，避免与 `userConfig` 混淆。
2. **精简说明（开关下两行）**：
   - 开：更快、更稳，少在静音/音乐处出现重复幻觉字幕；时间戳可能略不准。
   - 关：时间戳更贴合语音；但静音/音乐处可能产生重复或幻觉字幕。
   - 附一行：需要严格字幕时间轴对齐时可关闭。
3. **word_timestamps（仅 faster-whisper）**：`fasterWhisperEngine.ts` 的 `params` 增 `word_timestamps: true`。
   - 协议 `TranscribeSegment` 已含可选 `words`；开启后 faster-whisper 会把 `segment.end` 修正为真实末词时间，而 SRT 正是用 `segment.start/end` 生成（见下），故**段级时间戳自动受益，SRT 代码无需改**。
   - 健壮性：可按 `PingResult.protocolVersion` 兜底（旧引擎不支持就不发）；即便直接发，旧引擎忽略该参数也无害。
   - builtin 维持现状（whisper.cpp 词级时间戳依赖外部 `addon.node`，本仓库改不了；且 #1119 为 faster-whisper 专属）。

```149:159:main/helpers/engines/fasterWhisperEngine.ts
  const formattedSrt = formatSrtContent(
    (transcription?.segments || []).map(
      (segment) =>
        [
          secondsToSrtTime(segment.start),
          secondsToSrtTime(segment.end),
          segment.text || '',
        ] as [string, string, string],
    ),
  );
  await fs.promises.writeFile(srtFile, formattedSrt);
```

### 6.4 边界

- 老用户的全局 `useVAD` 不变（默认仍开）；高级选项开关只是新增的便捷入口，单一数据源不冲突。
- word_timestamps 略增 faster-whisper 计算耗时；需 1 次端到端冒烟，确认装机引擎确实生效（段 end 变准）。

### 6.5 受影响文件

- `renderer/components/tasks/AdvancedSheet.tsx`：识别区新增 VAD `Switch` + 说明（全局读写）。
- `main/helpers/engines/fasterWhisperEngine.ts`：`params` 增 `word_timestamps: true`（可选 protocolVersion 兜底）。
- i18n：`tasks`/`home` 的 VAD 开关标题与说明（zh/en）。
- 详细 VAD 参数/预设（`settings.tsx`）不动。

---

## 7. 受影响文件汇总

| 文件                                               | 主题   | 改动                                                               |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `renderer/components/resources/EnginesTab.tsx`     | T1     | completed 后 await `python-engine:ping`；按钮补 `!verifying`；文案 |
| `renderer/components/TaskControls.tsx`             | T2     | 起跑前模型兜底校验                                                 |
| `renderer/lib/engineModels.ts`                     | T2     | 加 `getInstalledModelsForEngine`                                   |
| `main/helpers/fileProcessor.ts`                    | T3     | 内封成功分支 `taskFileChange` 带 `embeddedSubtitle: true`          |
| `types/types.ts`                                   | T3     | `IFiles.embeddedSubtitle?: boolean`                                |
| `renderer/components/tasks/TaskRowList.tsx`        | T3, T4 | Captions 标识；与网格共享 stageUtils                               |
| `renderer/components/tasks/TaskGridList.tsx`（新） | T3, T4 | 网格卡片 + `<video>` 封面 + 图标兜底 + 角标                        |
| `renderer/pages/[locale]/tasks/[type].tsx`         | T2, T4 | 自动选模型 effect；视图切换/持久化/条件渲染                        |
| `main/helpers/store/{types,index}.ts`              | T4     | 新增 `settings.taskViewMode`（默认 `'list'`）                      |
| `renderer/components/tasks/AdvancedSheet.tsx`      | T5     | 识别区 VAD 开关 + 说明（全局读写）                                 |
| `main/helpers/engines/fasterWhisperEngine.ts`      | T5     | `params` 增 `word_timestamps: true`                                |
| i18n（zh/en：resources/tasks/home）                | T1–T5  | 各新增文案，保持 zh/en 键对等                                      |

---

## 8. 测试策略

### 8.1 门禁

- `npx tsc -p tsconfig.json`、`npm run test:engines`、`node scripts/check-i18n.mjs` 均通过，不新增存量错误。

### 8.2 手动验证矩阵

| 主题 | 场景                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------ |
| T1   | 下载 faster-whisper：进度→「正在检测引擎可用性…」→可用；检测期间下载/修复按钮隐藏/禁用；校验失败转修复 |
| T2   | 有已装模型但未选 → 进任务页自动选第一个；切引擎后模型随之更正；无模型起跑被 toast 拦截并指引下载       |
| T3   | 含内封文本字幕的 `.mkv` 直提 → 任务行出现 CC 图标，hover 文案正确；ASR 文件无图标                      |
| T4   | 列表/网格切换全局生效且记忆；`.mp4` 网格显示真实首帧；`.mkv`/`.ts` 显示类型大图标；音频/字幕显示大图标 |
| T5   | 高级选项开关与设置页同步（全局）；faster-whisper 开 word_timestamps 后段 end 更贴合（对比 #1119 现象） |
