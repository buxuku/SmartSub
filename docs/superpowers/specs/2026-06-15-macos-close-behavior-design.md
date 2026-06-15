# 关闭窗口行为设计（macOS 智能模式 + 跨平台防误杀）

> 状态：已评审（待写实现计划）
> 日期：2026-06-15
> 范围：关闭窗口（红叉/Cmd+W）时「转后台 vs 退出」的决策、首次提示、二次确认、设置项
> 关联：`main/background.ts`、`main/helpers/menu.ts`、`main/helpers/taskProcessor.ts`、`main/helpers/store/*`、`renderer/pages/[locale]/settings.tsx`

---

## 1. 背景与目标

### 1.1 现状取证（先纠偏）

代码里**没有任何 Tray / 菜单栏图标**。所谓「进托盘」其实是 macOS 上的窗口隐藏 + Dock 常驻：

```149:162:main/background.ts
  // macOS：关窗仅隐藏，后台任务（转写/翻译）继续；Cmd+Q 真退出
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // macOS：点击 Dock 图标恢复窗口
  app.on('activate', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });
```

```77:89:main/background.ts
/** Cmd+Q / 菜单退出时置位：区分「关窗」与「真退出」 */
let isQuitting = false;
let runtimeShutdownDone = false;
app.on('before-quit', (event) => {
  isQuitting = true;
  if (!runtimeShutdownDone) {
    event.preventDefault();
    runtimeShutdownDone = true;
    void shutdownPythonRuntime().finally(() => {
      app.exit(0);
    });
  }
});
```

结论：现有行为**已符合 macOS 惯例**（关窗 ≠ 退 App；`Cmd+Q` 优雅退出）。真正缺的是**可控性与提示**，不是缺退出。

### 1.2 目标

1. 关窗时不再让用户困惑「到底退没退」。
2. macOS 用「智能模式」：有任务转后台、空闲直接退出；并给一个可覆盖的设置项。
3. 顺手修掉 Windows/Linux 上「红叉关窗 → `window-all-closed` → `app.quit()` 直接杀掉运行中转写任务」的数据丢失隐患。

### 1.3 用户确认的关键决策

| 决策点          | 选择                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| 行为模型        | A · 智能模式（有任务后台 / 空闲退出）+ 可覆盖的设置项                                |
| 平台范围        | B · macOS 智能模式；Win/Linux 兜底「有任务二次确认后退出、空闲直退」，不做隐藏到后台 |
| 后台保活提示    | A · 首次转后台弹一次原生对话框（带「不再提示」+「立即退出」），之后静默隐藏          |
| 设置项形态      | 「系统设置」卡片下拉「关闭窗口时」，默认「智能」；macOS 三选项；Win/Linux 不显示     |
| Tray/菜单栏图标 | 不做                                                                                 |

### 1.4 非目标（本期不做）

- 不引入 Tray / 菜单栏状态图标（含 Win/Linux 的最小化到托盘）。
- 不改 `Cmd+Q` / Dock 右键退出 / 菜单退出语义（保持「始终真退出 + 现有 Python 优雅关闭」）。
- 不做「关窗后台」时的下载/模型安装保活判断（忙碌判断只看转写任务，见 §4）。

### 1.5 范围与门禁

- 一个设计文档 + 一个实现计划。
- 门禁（沿用本仓既有现实基线）：renderer 用 `npx tsc -p renderer/tsconfig.json` 不新增错误；主进程改动文件用根 `tsc` 输出按文件名过滤、不新增错误；新增 i18n 键过 `node scripts/check-i18n.mjs`（zh/en 对等）。

---

## 2. 行为矩阵（核心）

| 场景                               | macOS                              | Windows / Linux                                |
| ---------------------------------- | ---------------------------------- | ---------------------------------------------- |
| 关窗 · 空闲                        | 直接真退出                         | 直接真退出                                     |
| 关窗 · 有任务在跑                  | 转入后台（首次弹提示），任务继续   | 二次确认「任务还在运行，确定退出？」→ 确定才退 |
| `Cmd+Q` / Dock 右键退出 / 菜单退出 | 始终真退出（现有 Python 优雅关闭） | 始终真退出                                     |
| 设置 = 始终后台                    | 永远转后台（首次弹提示）           | 不提供该项                                     |
| 设置 = 始终退出                    | 空闲直退；有任务先二次确认         | （等同固定行为）                               |

「真退出」统一走 `app.quit()` → 现有 `before-quit`（优雅关闭 sidecar 再 `app.exit`），不重复实现退出收尾。

---

## 3. 忙碌判断（复用既有）

主进程已有现成的「是否有转写任务在跑/排队」判断：

```85:87:main/helpers/taskProcessor.ts
export function isTranscriptionBusy(): boolean {
  return activeTasksCount > 0 || processingQueue.length > 0;
}
```

改造：新增导出 `getTranscriptionBusyCount(): number`（= `activeTasksCount + processingQueue.length`），并把 `isTranscriptionBusy` 改写为 `getTranscriptionBusyCount() > 0`。提示文案用这个数显示「仍在后台处理 N 个任务」。

---

## 4. 设置模型（electron-store `settings`）

新增两个键：

| 键               | 类型                                | 默认值    | 说明                                                 |
| ---------------- | ----------------------------------- | --------- | ---------------------------------------------------- |
| `closeAction`    | `'smart' \| 'background' \| 'quit'` | `'smart'` | 关闭窗口时的行为；Win/Linux 忽略该值（固定兜底语义） |
| `closeHintShown` | `boolean`                           | `false`   | 首次后台提示是否已展示；勾「不再提示」后置 `true`    |

落点：`main/helpers/store/types.ts` 加类型，`main/helpers/store/index.ts` 的 `defaults.settings` 加默认值。`setSettings` 已是合并写入，无需改动。

---

## 5. 主进程设计

新建 `main/helpers/windowClose.ts`，把现在内联在 `background.ts` 的 close/quit 逻辑搬过去并扩展，保持 `background.ts` 精简、该逻辑可独立维护与测试。

### 5.1 退出状态集中管理

- 模块持有 `isQuitting`，导出 `getIsQuitting()` 与 `markQuitting()`。
- `background.ts` 的 `before-quit` 改调 `markQuitting()`（其余 Python 优雅关闭逻辑不动）。
- 「真退出」一律调 `app.quit()`（触发 `before-quit`），不直接 `mainWindow.destroy()`。

### 5.2 close 处理（决策入口）

```ts
mainWindow.on('close', (e) => {
  if (getIsQuitting()) return; // 真退出进行中：放行
  e.preventDefault();
  void handleWindowClose(mainWindow);
});
```

`handleWindowClose` 异步决策（读 `closeAction` + 平台 + 忙碌数）：

- **Windows/Linux**：忙碌 → 二次确认（`showMessageBoxSync`），确定则 `app.quit()`，取消则什么都不做（窗口留存）；空闲 → `app.quit()`。
- **macOS**：
  - `closeAction = 'quit'`：忙碌 → 二次确认；空闲 → `app.quit()`。
  - `closeAction = 'background'`：转后台（走首次提示逻辑）。
  - `closeAction = 'smart'`（默认）：忙碌 → 转后台（首次提示）；空闲 → `app.quit()`。

### 5.3 转后台 + 首次提示

- 用**异步** `dialog.showMessageBox`（能拿到「不再提示」勾选态），父窗口 = 主窗口。
- 仅当 `settings.closeHintShown !== true` 时弹；弹前窗口仍可见（对话框有依附）。
- 按钮 `[转入后台(默认)] [立即退出]`，`checkboxLabel = 不再提示`。
  - 选「转入后台」→ `mainWindow.hide()`；若勾了「不再提示」则持久化 `closeHintShown: true`。
  - 选「立即退出」→ `app.quit()`（只退本次，不改 `closeAction`）。
- 非首次（`closeHintShown === true`）→ 直接 `mainWindow.hide()`，不弹。
- 文案按忙碌数自适应：忙碌「仍在后台处理 N 个任务，要彻底退出请用 Cmd+Q 或 Dock 右键 → 退出」；`background` 模式空闲「应用将继续在后台运行，要退出请用 Cmd+Q…」。

### 5.4 二次确认（quit 路径 / Win·Linux 忙碌）

- 用 `dialog.showMessageBoxSync`（只需按钮结果），`type: 'warning'`，按钮 `[退出] [取消]`，`defaultId`/`cancelId` 指向「取消」。
- 返回「退出」→ `app.quit()`；否则窗口留存。

### 5.5 i18n（主进程）

主进程不引 i18n 运行时，仿照 `menu.ts` 的双语字典写法：在 `windowClose.ts` 内维护 zh/en 文案，按 `store.get('settings').language` 取值（回退 `app.getLocale()`）。

---

## 6. 渲染层设置 UI（`settings.tsx`）

- 在「系统设置」卡片内新增一个下拉（与「语言」「代理模式」同款 `Select`），标题「关闭窗口时」，加 `HelpHint` 简述三种行为。
- 三项：智能（推荐）/ 最小化到后台 / 退出应用，对应 `closeAction` 的 `smart` / `background` / `quit`。
- **仅 macOS 渲染**：用已注入的 `window.ipc.platform === 'darwin'` 判断（参考 `renderer/components/UpdateDialog.tsx` 既有用法）。
- 加载时从 `getSettings` 读 `closeAction`（默认 `smart`）；变更时 `setSettings({ closeAction })` 持久化，`toast` 成功提示沿用既有 `saveFailed`/成功文案模式。
- `settings.json`（zh/en）补：标题、3 个选项、HelpHint 文案。

---

## 7. 边界处理

- **防重复弹窗**：模块内加 `closePromptOpen` 锁，连点红叉不叠加对话框（锁定期间后续 close 直接忽略）。
- **自动更新**：`quitAndInstall` 等走 `app.quit()` → `before-quit` 置位 → close 放行，不被拦截。
- **`window-all-closed`**：维持现状（非 mac 退出）。Win/Linux 二次确认「取消」时已 `preventDefault`，窗口不关、该事件不触发；「确定」时由我们 `app.quit()`，仍能正常退出。
- **语义隔离**：「不再提示」只压制提示、「立即退出」只退本次，都不改 `closeAction` 设置本身。
- **隐藏后恢复**：保留现有 `app.on('activate')` 显示窗口；菜单项的 `sendToRenderer` 已会 `win.show()`。

---

## 8. 验证

- 类型检查：renderer (`renderer/tsconfig.json`) + 主进程改动文件按既有基线过滤，均不新增错误。
- i18n：`node scripts/check-i18n.mjs` 通过（新增设置键 zh/en 对等）。
- 手动覆盖行为矩阵每一格：
  - macOS 智能：跑任务 → 红叉 → 首次弹提示 → 转入后台 → 窗口隐藏、Dock 图标在、任务继续；点 Dock 恢复。空闲红叉 → 退出。
  - macOS 始终后台 / 始终退出：分别验证恒后台、空闲直退 + 忙碌二次确认。
  - Win/Linux：忙碌红叉 → 二次确认拦下；空闲红叉 → 退出；设置项不显示。
  - `Cmd+Q` 始终优雅退出；勾「不再提示」后不再弹。
