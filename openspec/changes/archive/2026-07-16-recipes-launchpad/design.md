# Design: 配方与启动台（P4）

## Context

- 向导（P2）已是"目标勾选 → 阶段推导 → 本地表单配置 → 快照执行"的完整创建面；把关开关（P3）也在向导内。配方本质上就是**向导状态的命名快照**。
- 启动台现状：6 张卡（3 张任务类型 + 3 张工具页）+ P2 加的「视频 → 配音成片」卡，任务与工具混排；拖放建任务的机制已有两套（slug 卡直建工程、向导卡 sessionStorage 交接）。
- 探索期定稿：配方卡是小白的主入口（拖放即跑、白话命名），向导降级为次入口（自定义时才见）；工具独立分层。

## Goals / Non-Goals

**Goals:**

- 配方 = 目标 + 完整任务配置（含 dub/compose/gates）的命名快照；保存自向导、应用回向导或直达任务页。
- 启动台收口为「配方（开始创作）+ 工具（单文件精修）+ 最近任务」三层心智。
- 老三类任务无损映射为内置配方；执行面零回归。

**Non-Goals:**

- 配方分享/导入导出、按配方统计；命令面板配方命令。
- 字幕输入的视频配对；home.json 文案迁移。
- 不改任务执行体与闸门机制（P1–P3 已定）。

## Decisions

### D1. 配方模型：向导状态的命名快照，两种应用形态

```
TaskRecipe {
  id, name, builtin?: boolean,
  goals: { translate, dub, video },        // 向导目标勾选
  accepts: 'media' | 'subtitle',           // 输入类型（决定路由与卡片拖放过滤）
  config?: Partial<IFormData>,             // 字幕段配置 + dub/compose/gates（用户配方快照）
}
```

- **应用规则**：`goals` 无 dub/video 的"纯字幕配方"→ 直达既有任务页 `/tasks/[slug]`（由 accepts+translate 推导 slug；拖放即建工程，现状机制）——保证老三类的功能面（outcome 档位、高级选项等）零损失；含附加阶段的配方 → 向导 `?recipe=<id>` 预填（拖放经 sessionStorage 交接，P2 机制）。推导为纯函数（`recipeTarget(recipe)` / `recipeToWizardPrefill(recipe)`），可单测。
- **内置配方**不落存储（代码常量，`builtin: true`，i18n 命名），四张：视频→配音成片（featured，goals 全开 + 默认把关）、视频→双语字幕、视频→字幕、字幕翻译。用户配方持久化于 store `taskRecipes`。
- **为什么不把内置也落库**：升级迭代内置配方（文案/默认值）无需数据迁移；用户配方与内置在 UI 合并展示。

### D2. 保存自向导：快照当前有效配置

向导「存为配方」= 命名对话框 + 打包 `{goals, accepts, config}`——config 取向导本地表单的字幕段字段（引擎/模型/语言/服务商/输出等）+ dub（引擎/音色/语速…）+ compose（字幕方式）+ gates（两开关）。应用配方时向导 `form.reset(config)` + goals/gates 状态回填；TTS 引擎等就绪性仍走既有校验（配方引用的引擎被删时按既有回落与内联引导，不阻塞打开）。

### D3. 启动台改版：三层布局，机制复用

- 「开始创作」面板：配方卡网格（内置在前、featured 首位；用户配方随后；末尾「＋ 自定义流程」虚线卡进空白向导）。卡片交互沿用现状：点击=进入对应目标（任务页/向导）；拖放=即跑（slug 直建工程 / 向导 sessionStorage 交接，按 D1 规则分流）；hover 展示用户配方的重命名/删除操作（内置无）。
- 「工具」子区：校对/配音/合成三个工作台入口移入紧凑行（图标+名称），与配方卡视觉分层——响应探索期"卡片有的是任务、有的是页面"的混淆点。
- 就绪阻断徽章按配方 goals 推导：需转写（media）→模型；translate→翻译服务；dub→TTS 就绪（沿用 launchpad 已有的 ttsReady 探测）；未就绪点击改跳配置页（现状机制推广）。

### D4. 存储与 IPC

store 增 `taskRecipes: TaskRecipe[]`（默认 `[]`）；IPC `recipes:list / save / rename / delete`（新 `ipcRecipeHandlers.ts`，形制同 workItemHandlers 的薄 CRUD）。删除仅作用于用户配方。

## Risks / Trade-offs

- [配方 config 随版本演进出现陈旧字段] → 应用时浅合并到向导当前默认值之上（缺字段回落默认），不做严格 schema 校验；引擎/服务商失效由既有就绪校验兜底。
- [启动台改版触碰新手引导/拖放回归] → 布局改动限于「开始创作」面板内部；EnvReadiness/最近任务/引导逻辑不动；拖放两套机制均为现状复用。
- [内置配方与旧卡片文案的深链习惯] → slug 路由不变；内置配方命名沿用旧卡文案（i18n 键复用或映射）。

## Migration Plan

1. 类型/存储/IPC（零 UI 变化）→ 2. lib/recipes 推导纯函数 + 单测 → 3. 向导存为配方 + recipe 预填 → 4. 启动台改版 + i18n → 5. 冒烟。
   回滚：启动台改版独立 commit，可单独回退到现状卡片。

## Open Questions

- 用户配方是否需要"更新配方"（覆盖保存）入口——P4 先只做另存新配方，观察使用。
