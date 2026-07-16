# Tasks: recipes-launchpad

## 1. 配方模型、存储与 IPC（零 UI 变化）

- [x] 1.1 `types/recipe.ts`：`TaskRecipe { id, name, builtin?, goals: {translate,dub,video}, accepts: 'media'|'subtitle', config?: Partial<IFormData> }`
- [x] 1.2 `main/helpers/store/`：`taskRecipes` key（默认 `[]`）；新增 `ipcRecipeHandlers.ts`（`recipes:list/save/rename/delete`，薄 CRUD，删除仅限非内置）并在 background 注册
- [x] 1.3 `renderer/lib/recipes.ts`：内置配方常量（4 张，i18n 键命名）+ 纯函数——`recipeTarget(recipe, locale)`（纯字幕→任务页路由；含附加阶段→向导 `?recipe=`）、`recipeBlock(recipe, readiness)`（模型/翻译/TTS 就绪阻断推导）、`recipeToWizardPrefill(recipe)`

## 2. 向导集成

- [x] 2.1 「存为配方」：行动区入口 + 命名对话框 → 打包 `{goals, accepts, config(字幕段+dub+compose+gates)}` 经 `recipes:save` 保存，toast 反馈
- [x] 2.2 `?recipe=<id>` 预填：加载配方（内置走常量、用户走 IPC）→ goals/gates 状态回填 + `form.reset(浅合并 config)` + dub/compose 配置回填；失效引用按既有就绪校验回落；与 sessionStorage 文件交接共存（原 `?preset=full` 改由内置一条龙配方 id 承接，保留兼容）
- [x] 2.3 i18n zh/en（tasks.json wizard.recipe.\*）

## 3. 启动台改版

- [x] 3.1 `home.tsx` 配方卡区：内置（featured 首位）+ 用户配方（`recipes:list` 加载）+「＋ 自定义流程」卡；点击/拖放按 `recipeTarget` 分流（slug 直建工程 / 向导 sessionStorage 交接）；就绪阻断按 `recipeBlock` 推导（含 TTS 就绪，未就绪跳配置页）
- [x] 3.2 用户配方卡管理：hover 重命名（内联输入）与删除（确认对话框），仅用户配方可见
- [x] 3.3 工具区分层：校对/配音/合成入口移入「工具」紧凑行，与配方卡视觉区分；移除旧的三张任务类型卡与工具卡（由内置配方与工具行替代）
- [x] 3.4 i18n zh/en（launchpad.json：配方区/工具区/管理操作/阻断文案）

## 4. 验证与冒烟

- [x] 4.1 单测：`recipeTarget`/`recipeBlock`/`recipeToWizardPrefill` 纯函数（test:pipeline 扩展或独立脚本）；tsc（main/renderer）、prettier、check:i18n、yarn build
- [x] 4.2 真机冒烟·配方闭环：向导配好一条龙 → 存为配方 → 启动台出现 → 拖 2 个视频到该卡 → 向导预填正确 → 开始跑通；重命名/删除配方
- [x] 4.3 真机冒烟·内置与回归：四张内置配方点击/拖放行为正确（纯字幕直达旧任务页零回归）；未就绪阻断跳配置页；工具行直达三个工作台；最近任务/引导不受影响
