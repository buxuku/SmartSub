# 批次 11 设计：信息架构与桌面公民身份

对应报告条目：5.4 页面头部两模板、5.1 空态四要素、4.6.1 应用菜单、4.6.4/6.8.1 更新双提示与手动检查、4.6.7 Mac 正向加速/Win 中性文案、6.6.5 设置页关于、4.1.5 模型路径双入口、4.1.6 最近任务查看全部、4.1.1 侧边栏命名残留。

用户已确认方案（回复 A）。

## 现状结论（探索）

1. 六页面六种头部做法，合成页无头部；无 PageHeader/EmptyState 公共组件。
2. 主进程无 Menu 定制，默认英文菜单；语言存 `store.settings.language`，切换走 `setSettings` IPC。
3. 更新双提示：`updater.ts` L96-110 原生 dialog + `UpdateNotification.tsx` L46-54 toast 同时弹；`check-for-updates` IPC 已存在但无 UI 入口；顶栏火箭图标 `text-destructive` 且仅 available 时出现；`UpdateDialog.tsx` 用 userAgent 判断 mac。
4. `Layout.tsx` L216 `capable = platform !== 'darwin'` → mac 顶栏无加速徽章；Win 无卡用户永久看到「GPU 加速未启用」+ ZapOff。`get-active-backend` 已返回 metal/coreml/cpu。
5. 设置页：模型路径完整选择器与资源中心双入口；GPU 过渡卡注释「一个版本后可移除」已到期；无「关于」区块；版本号在顶栏 `packageInfo.version`。
6. 最近任务 `slice(0, 8)` 无查看全部；`getTaskProjects` 返回全量。
7. 命名残留：侧边栏「字幕校对」vs 启动台卡片「校对字幕」。

## 设计决策

### T1 PageHeader / EmptyState

- `components/PageHeader.tsx`：`{ title, description?, actions?, children? }`，`h1 text-2xl font-semibold tracking-tight` + `text-sm text-muted-foreground` 描述 + 右侧 actions 槽。枢纽页用。
- `components/EmptyState.tsx`：`{ icon, title, description?, action? }`，居中竖排，icon 在 muted 圆底上。
- 接入：启动台（标题区改组件）、资源中心、设置页（补描述文案）、合成页（补头部「合成到视频」+描述）、校对列表页；最近任务空态换 EmptyState。任务页工作页模式不动。
- 命名统一：zh `common.json subtitleProofread` 「字幕校对」→「校对字幕」，en 保持 'Proofread Subtitles' 风格统一。

### T2 应用菜单本地化（main/helpers/menu.ts）

- `buildAppMenu(language)`：mac = 应用(about/quit role)/编辑(role 全套)/视图(reload/devtools/zoom/fullscreen role)/窗口(role)/帮助；Win/Linux = 文件(quit)/编辑/视图/帮助。label 用内置 zh/en 字典（主进程不引 i18n 库，双语字典直接写在 menu.ts）。
- 帮助菜单项：检查更新 → `webContents.send('menu-check-updates')`；查看日志 → `webContents.send('menu-open-logs')`；GitHub → `shell.openExternal`。renderer Layout 监听两事件复用现有 UI。
- 重建时机：app ready 时构建一次；`ipcStoreHandlers` setSettings 检测 language 变化后重建。
- 语言 fallback：`store.settings.language ?? (app.getLocale().startsWith('zh') ? 'zh' : 'en')`。

### T3 更新链路

- 删 `updater.ts` update-downloaded 的 `dialog.showMessageBox`（保留 toast，toast 已带「立即安装」action）。
- 删 `checkForUpdates` 非 silent 时的 `dialog.showErrorBox`（手动检查的失败反馈由 renderer 出 toast）；IPC `check-for-updates` 保持。
- renderer 新增 `hooks/useUpdateCheck.ts`：`checkNow()` 调 IPC 并临时监听 update-status，四态 toast（checking 用 toast.loading、not-available、error；available 时打开 UpdateDialog）。Layout 帮助菜单 + 设置页关于复用。
- 顶栏火箭图标 → `Badge`「新版本 vX」文字徽章，primary 色调，点击仍开 UpdateDialog。
- `UpdateDialog` mac 判断改用 `window.ipc.invoke('getSystemInfo')` 的 platform 字段（或新增轻量 'get-platform'——探索后定，优先复用现有）。

### T4 加速徽章平台分支

- Layout：darwin 不再整体隐藏。darwin 时拉 `get-active-backend`：metal/coreml → 绿色 Zap「Metal 加速 / CoreML 加速」徽章（点击仍跳 acceleration tab）；cpu → 中性「CPU 模式」。
- 非 darwin：保持现有逻辑，但 `gpuEnabled === false` 时文案改中性「CPU 模式」（muted 前景 + Zap 轮廓，去 ZapOff），仅 gpuMode 显式 cpu-only 或检测无卡时如此；可启用而未启用的场景维持现状提示。简化执行：统一改为「CPU 模式」中性灯，不再出现「GPU 加速未启用」负面文案。

### T5 设置页三件套

- 「关于」卡（页尾、恢复默认区之前）：应用名+版本行、检查更新按钮（复用 useUpdateCheck）、GitHub 仓库、反馈 issue、查看日志（触发 LogDialog 同款事件——设置页直接 render LogDialog 或发事件给 Layout；简化：设置页自带 LogDialog 实例）。
- 模型路径区块整体替换为「模型存储路径已移至资源中心」+ 「前往」按钮（同 GPU 过渡卡样式）；删除 GPU 过渡卡。
- `settings.json` 增 about 相关 key；删除不再使用的 modelsPath 选择器相关 key（保留 resources 用到的）。

### T6 最近任务查看全部

- home.tsx：`projects` 保存全量；默认渲染前 8 条。标题行右侧 ghost 按钮「查看全部 (N)」切换 expanded；expanded 时显示搜索框（按工程名 includes 过滤，不分大小写）+ 全量列表，按钮变「收起」。
- 空态换 EmptyState（icon: History，主文案现有 noRecentTasks，副文案新增提示拖文件开始）。

### T7 i18n + 门禁 + 交接

- zh/en 新 key；`yarn check:i18n` 通过；renderer TSC 0、main TSC ≤95；交接附验证清单（菜单/更新/徽章需实机验证项单列）。

## 风险

- 菜单 role 在三平台行为差异，mac 实机验证必需。
- 更新链路改动仅删提示与加入口，不动下载/安装逻辑。
