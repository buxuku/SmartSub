# 批次 10 实施计划：术语统一与 i18n 治理

对应设计：`docs/superpowers/specs/2026-06-12-i18n-terminology-b10-design.md`

> **状态：已完成（2026-06-12）**
>
> - T1 术语替换：commit `4ad14d7`（zh/en 全量 + 代码注释）
> - T2 死键清理：commit `c783d59`（200 死键 ×2 语言；LogDialog/structuredOutput 补 i18n）
> - T3 兜底移除：commit `d03d0d0`（260 处 tsx）+ `a10fa99`（16 处 hooks .ts）
> - T4 校验脚本：commit `a10fa99`（`scripts/check-i18n.mjs` + `yarn check:i18n`；顺带修复 4 个真缺键：errorReadSubtitle/errorConvertToVTT/selectOption/noMatchingModels）
> - T5 门禁：renderer TSC 0；main TSC 95=基线；check:i18n 通过（parity 与兜底两分支均验证过退出 1 行为）

## Task 1：术语表全量替换

**文件**：`renderer/public/locales/{zh,en}/*.json`

1. 列出 zh 全部含「听写/识别/显卡加速/视频合字幕/源始」的 key，逐条按术语表改写（脚本输出清单 + 逐条人工定稿，不盲目 sed）。
2. en 对应 key 同步：Recognition→Transcription（语音语境）、保持 Transcribe 统一。
3. `tasks.json configBar.style` zh「字幕样式」→「输出内容」，en「Subtitle Style」→「Output Content」。
4. 「自动识别」（autoRecognition，语言自动检测语境）保留不动。

**验证**：grep zh locales 无语音语境「听写」「识别」残留；界面抽查任务页阶段链、引导、资源中心。

## Task 2：死键清理 + 硬编码 i18n 化

1. grep 代码中动态 key 模式（`` t(` ``）形成前缀豁免清单（provider.、card.、stage.、language.、modelDesc. 等）。
2. 重跑死键扫描（豁免后），人工复核清单，zh/en 同步删除。
3. `LogDialog.tsx` 英文描述补 `logsDesc` key（zh/en）。

**验证**：删除后全量 grep 确认无引用；TSC 通过；主要页面冒烟无 key 裸露。

## Task 3：移除 i18n 兜底

1. 脚本替换 `t('key') || '...'`、`t('key', {...}) || '...'` → 去掉 `|| '...'`（components + pages 全量 tsx）。
2. 抽查 SubtitleEditToolbar（83 处）、BatchAiOptimizeDialog（43 处）diff。

**验证**：grep `t('` 后跟 `|| '` 为 0；TSC；编辑器/合成页冒烟文案正常。

## Task 4：check-i18n 校验脚本

**文件**：`scripts/check-i18n.mjs`（新建）、`package.json`

1. 脚本功能：① zh/en 文件集合与 key 集合 diff，非空退出码 1；② 扫描 renderer 源码新增 `t('...') || ` 兜底模式则告警退出 1。
2. `package.json` scripts 增加 `"check:i18n": "node scripts/check-i18n.mjs"`。

**验证**：当前仓库跑 `yarn check:i18n` 退出 0；手工造一个缺 key 验证退出 1 后还原。

## Task 5：门禁 + 验收交接

1. `cd renderer && npx tsc --noEmit`：非测试 0 错误。
2. 根 `npx tsc --noEmit` 过滤 `^main/`：= 95 基线。
3. `yarn check:i18n` 退出 0。
4. 每 Task 一个 commit；interactive_feedback 交接附验证建议。
