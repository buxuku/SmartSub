# Tasks: fix-dubbing-bilingual-speech-text

## 1. 译文定位与 sidecar 归属

- [x] 1.1 新增 `main/helpers/dubbing/bilingualScript.ts`：`bilingualContentType`（只有 `finalTargetFile` 或内容类型等于 `translateContent` 的输出才算双语交付物，`sourceFile`、`targetFile`、源语言输出一律排除）、`resolveDubbingScript`（逐行定位译文块：译文在前取开头、在后取末尾，先匹配 sidecar 译文再回退原文，比较忽略空白；定位不到的行保留整行并记入 `unresolved`）
- [x] 1.2 `speakerMetadata.ts`：`readOwnedPaths` 并入 `subtitleOutputFilesToSave(meta, translateContent)` 的全部路径（第二交付格式、`tempFinalSubtitleFile` 等）；行配对规则抽成 `alignSidecarCues`（行为不变）；`loadDubbingSpeakerMetadata` 可接收调用方已有的 sidecar 查找结果，避免重复查找
- [x] 1.3 `types/dubbing.ts`：新增 `BilingualCueDisplay`（`lines` / `from` / `to`）

## 2. 会话接入

- [x] 2.1 `createDubbingSession`：单次 sidecar 查找，行文本取 `resolveDubbingScript` 的结果；至少一行定位成功时字幕语言取 sidecar 目标语言（显式传入的语言优先）；检测语言按实际朗读文本计算；有行定位不到时写警告日志
- [x] 2.2 `SessionCue.display` / `PersistedDubbingCue.display`（可选）：`toSessionMeta` 落盘、`restoreDubbingSession` 恢复；`session.json` 版本号不变，旧会话无此字段照常加载
- [x] 2.3 `bilingualScript.ts` 新增 `composeDisplayText`：未编辑原样还原，编辑后只替换译文块，清空则只剩原文行
- [x] 2.4 `exportDubbing`：导出顺延字幕时把 `composeDisplayText` 的结果作为 `displayTextByIndex` 传给 `buildDubTrack`，时间轴仍取对齐规划结果

## 3. 测试

- [x] 3.1 `scripts/dubbing/test-dubbing-units.ts`（纯函数）：交付物判定（两种顺序、纯译文与未知内容不算双语）、译文定位矩阵（折叠后的 CJK 无空格排版、多行译文、手改译文 / 手改原文 / 两列都改、个别行无法定位、原文为空与缺译文、条数不同时按时间对齐 / 时间对不上不猜 / 时间轴被调整时按下标对齐）、`composeDisplayText`（未编辑、编辑、清空、无版面、多行译文、译文在前）、sidecar 归属覆盖第二交付格式与带时间轴副本且无关字幕不被认领；另有一组用生产排版函数（`layoutSubtitleColumns` 两行布局、`CONTENT_TEMPLATES` 模板、`prefixTextWithSpeakerNames`）写出交付字幕的矩阵：两种顺序 × 模板 / 两行布局 × 有无说话人名 × 9 组文本（含 CJK、多行双列、原文译文相同、纯括号内容）共 72 种，全部定位到译文且 `composeDisplayText` 原样还原交付文本；对定位逻辑做过变异检查（比较不再忽略空白、译文块取错一端都会失败）
- [x] 3.2 `scripts/dubbing/test-language-flow.cjs`（真实会话路径）：`.srt` / `.vtt` / 带时间轴副本三种交付文件都只念译文且无需传入 sidecar；`runDubbingBatch` 送到 TTS 运行时的请求只含译文且语言为 sidecar 目标语言；检测语言为 `zh`；重开会话后版面与文本不变且复用已有音频；流水线的纯译文字幕即使带着同一份 sidecar 也不被当作双语；一行两列都改过时只该行整行念；没有 sidecar 的外部双语字幕整行念
- [x] 3.3 `scripts/dubbing/test-auto-fit.cjs`（真实 WAV 导出）：未编辑时顺延字幕逐行还原双语、编辑后只替换译文行、重开会话后仍保留双语；对 `composeDisplayText` 做过变异检查（让它忽略版面后导出断言失败）
- [x] 3.4 先写测试并确认在修复前失败：会话文本与 TTS 请求含原文、`display` 缺失、`aligned.srt` 只剩单语、四个交付路径认不出 sidecar；再实现

## 4. 验证

- [x] 4.1 `yarn typecheck` 通过
- [x] 4.2 配音相关：`test:dubbing`（单测 318 项 + 会话流程）、`test:dubbing-speakers`、`test:dubbing-ownership`、`test:dubbing-auto-fit` 通过；流水线与校对数据：`test:pipeline`、`test:proofread-data`、`test:proofread-storage` 通过
- [x] 4.3 CI 的其余步骤：`check:i18n`、`test:renderer`（65 个套件、628 条用例）、`test:parameter-persistence`、`test:pro-baseline`（42 条命令全部通过，含 `test:dubbing-speakers`、`test:dubbing-ownership`、`test:dubbing-auto-fit`、`test:pipeline`、`test:proofread-storage`）、`yarn build`（renderer + main + CLI/MCP 入口）通过
- [x] 4.4 `openspec validate fix-dubbing-bilingual-speech-text --strict` 通过
