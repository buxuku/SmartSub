# 关闭窗口行为 Implementation Plan（macOS 智能模式 + 跨平台防误杀）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关窗时 macOS 走「有任务转后台/空闲退出」的智能模式（可在设置覆盖），Windows/Linux 补上「有任务二次确认再退」的防误杀，杜绝「关窗到底退没退」的困惑，且不引入 Tray 图标。

**Architecture:** 决策逻辑抽成纯函数 `windowCloseDecision.ts`（无 Electron，可被 `test:engines` 覆盖）；Electron 侧 `windowClose.ts` 负责对话框/隐藏/退出与退出状态集中管理，`background.ts` 仅做装配；忙碌判断复用 `taskProcessor` 既有计数；新增 `settings.closeAction` / `settings.closeHintShown` 两个持久化键，渲染层在「系统设置」加下拉（仅 macOS 显示）。「真退出」一律 `app.quit()` 走既有 `before-quit` 优雅关闭。

**Tech Stack:** Electron 30（`app` / `BrowserWindow` / `dialog`）、electron-store 8、Next.js 14 + React 18（renderer 设置页）、next-i18next（zh/en）、自研纯逻辑测试脚本 `scripts/test-engine-units.ts`（`npm run test:engines`）。

---

## 设计依据

实现严格对齐 spec：`docs/superpowers/specs/2026-06-15-macos-close-behavior-design.md`。关键行为矩阵（§2）：

| 场景                             | macOS                    | Windows / Linux  |
| -------------------------------- | ------------------------ | ---------------- |
| 关窗·空闲                        | 真退出                   | 真退出           |
| 关窗·有任务                      | 转后台（首次提示）       | 二次确认后退出   |
| Cmd+Q / Dock 右键退出 / 菜单退出 | 始终真退出               | 始终真退出       |
| 设置=始终后台                    | 永远转后台（首次提示）   | 不提供           |
| 设置=始终退出                    | 空闲直退；有任务二次确认 | （等同固定行为） |

## File Structure

| 文件                                       | 动作   | 职责                                                                 |
| ------------------------------------------ | ------ | -------------------------------------------------------------------- |
| `main/helpers/windowCloseDecision.ts`      | Create | 纯决策函数 `decideCloseIntent`（无 Electron 依赖，可单测）           |
| `scripts/test-engine-units.ts`             | Modify | 追加 `decideCloseIntent` 行为矩阵单测                                |
| `main/helpers/store/types.ts`              | Modify | settings 加 `closeAction` / `closeHintShown` 类型                    |
| `main/helpers/store/index.ts`              | Modify | defaults 加 `closeAction:'smart'` / `closeHintShown:false`           |
| `main/helpers/taskProcessor.ts`            | Modify | 新增 `getTranscriptionBusyCount()`，`isTranscriptionBusy` 改写复用   |
| `main/helpers/windowClose.ts`              | Create | Electron 侧装配：close 监听、对话框、隐藏/退出、退出状态、双语文案   |
| `main/background.ts`                       | Modify | 移除内联 close/activate 与本地 `isQuitting`，改用 `windowClose` 模块 |
| `renderer/pages/[locale]/settings.tsx`     | Modify | 「系统设置」加「关闭窗口时」下拉（仅 macOS）                         |
| `renderer/public/locales/zh/settings.json` | Modify | 新增 closeAction 相关文案                                            |
| `renderer/public/locales/en/settings.json` | Modify | 新增 closeAction 相关文案                                            |

## Testing Reality（本仓现实门禁）

- 本仓**无 Jest/Vitest**；纯逻辑用 `scripts/test-engine-units.ts` + `npm run test:engines`（tsc 编译后 node 跑，`eq()` 断言）。`decideCloseIntent` 无 Electron 依赖，纳入该脚本。
- Electron 生命周期 / `dialog` / `app.quit` **无法自动化**，靠手动冒烟（见末节矩阵）。
- 根 `tsconfig.json` 历史上**非 tsc 干净**（含 docs/renderer 噪声），主进程改动用「grep 改动文件名、不出现新错误」判定。
- 渲染层用 `npx tsc -p renderer/tsconfig.json` 判定，只看改动文件不新增错误。
- i18n 用 `npm run check:i18n`（zh/en 键对等）。

---

## Task 1: 纯决策函数 + 单测

**Files:**

- Create: `main/helpers/windowCloseDecision.ts`
- Test: `scripts/test-engine-units.ts`

- [ ] **Step 1: 先写失败测试**（追加到 `scripts/test-engine-units.ts`）

在文件**导入区末尾**（紧跟第 37 行 `} from '../main/helpers/embeddedSubtitleParser';` 之后）追加导入：

```ts
import { decideCloseIntent } from '../main/helpers/windowCloseDecision';
```

在文件**断言区末尾**（第 367 行 `eq(srtHasCues('   \n  \n'), false, 'embed: whitespace srt no cue');` 之后、`console.log` 之前）追加：

```ts
// --- decideCloseIntent (关闭窗口行为矩阵) ---
eq(
  decideCloseIntent({ platform: 'darwin', closeAction: 'smart', busy: true }),
  'background',
  'close: mac smart busy -> background',
);
eq(
  decideCloseIntent({ platform: 'darwin', closeAction: 'smart', busy: false }),
  'quit',
  'close: mac smart idle -> quit',
);
eq(
  decideCloseIntent({
    platform: 'darwin',
    closeAction: 'background',
    busy: false,
  }),
  'background',
  'close: mac background idle -> background',
);
eq(
  decideCloseIntent({
    platform: 'darwin',
    closeAction: 'background',
    busy: true,
  }),
  'background',
  'close: mac background busy -> background',
);
eq(
  decideCloseIntent({ platform: 'darwin', closeAction: 'quit', busy: false }),
  'quit',
  'close: mac quit idle -> quit',
);
eq(
  decideCloseIntent({ platform: 'darwin', closeAction: 'quit', busy: true }),
  'confirm-quit',
  'close: mac quit busy -> confirm-quit',
);
eq(
  decideCloseIntent({ platform: 'win32', closeAction: 'smart', busy: true }),
  'confirm-quit',
  'close: win busy -> confirm-quit',
);
eq(
  decideCloseIntent({ platform: 'win32', closeAction: 'smart', busy: false }),
  'quit',
  'close: win idle -> quit',
);
eq(
  decideCloseIntent({
    platform: 'linux',
    closeAction: 'background',
    busy: true,
  }),
  'confirm-quit',
  'close: linux ignores background, busy -> confirm-quit',
);
eq(
  decideCloseIntent({
    platform: 'linux',
    closeAction: 'background',
    busy: false,
  }),
  'quit',
  'close: linux ignores background, idle -> quit',
);
```

- [ ] **Step 2: 跑测试确认失败（模块不存在 → 编译失败）**

Run: `npm run test:engines`
Expected: 失败，报 `Cannot find module '../main/helpers/windowCloseDecision'` 或 TS2307。

- [ ] **Step 3: 写最小实现**

Create `main/helpers/windowCloseDecision.ts`：

```ts
/**
 * 关闭窗口意图决策（纯函数，无 Electron 依赖，便于 test:engines 覆盖）。
 * 行为矩阵见 docs/superpowers/specs/2026-06-15-macos-close-behavior-design.md §2。
 */
export type CloseAction = 'smart' | 'background' | 'quit';

/**
 * - 'quit'：直接真退出（由调用方走 app.quit → before-quit 优雅关闭）
 * - 'confirm-quit'：有任务在跑，先二次确认再退
 * - 'background'：转入后台（隐藏窗口；首次提示由 UI 层处理）
 */
export type CloseIntent = 'quit' | 'confirm-quit' | 'background';

export function decideCloseIntent(input: {
  platform: NodeJS.Platform;
  closeAction: CloseAction;
  busy: boolean;
}): CloseIntent {
  const { platform, closeAction, busy } = input;

  // 非 macOS：不做隐藏到后台（无托盘会找不到窗口）。忙碌则二次确认防误杀，空闲直接退。
  if (platform !== 'darwin') {
    return busy ? 'confirm-quit' : 'quit';
  }

  // macOS：按设置走。
  if (closeAction === 'background') return 'background';
  if (closeAction === 'quit') return busy ? 'confirm-quit' : 'quit';
  // 'smart'（默认/兜底）：有任务转后台，空闲直接退。
  return busy ? 'background' : 'quit';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:engines`
Expected: 末行 `engine unit tests: N passed, 0 failed`，退出码 0（N 比改前多 10）。

- [ ] **Step 5: 提交**

```bash
git add main/helpers/windowCloseDecision.ts scripts/test-engine-units.ts
git commit -m "feat(close): pure decideCloseIntent + unit tests for close behavior matrix"
```

---

## Task 2: 设置 schema（类型 + 默认值）

**Files:**

- Modify: `main/helpers/store/types.ts:55-56`
- Modify: `main/helpers/store/index.ts:38`

- [ ] **Step 1: 加类型**

在 `main/helpers/store/types.ts` 的 `taskViewMode` 行后追加（当前第 55-56 行）：

```ts
    /** 任务列表视图：list=列表，grid=网格（全局统一，跨重启保留） */
    taskViewMode?: 'list' | 'grid';
    /** 关闭窗口行为：smart=有任务转后台/空闲退出，background=始终后台，quit=始终退出（仅 macOS 生效，Win/Linux 固定兜底） */
    closeAction?: 'smart' | 'background' | 'quit';
    /** 首次「转入后台」提示是否已展示（勾「不再提示」后置 true） */
    closeHintShown?: boolean;
```

- [ ] **Step 2: 加默认值**

在 `main/helpers/store/index.ts` 的 `taskViewMode` 默认值行后追加（当前第 38 行）：

```ts
      taskViewMode: 'list' as const,
      closeAction: 'smart' as const,
      closeHintShown: false,
```

- [ ] **Step 3: 类型门禁（不新增错误）**

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "store/(types|index)\.ts" || echo "STORE_CLEAN"`
Expected: 输出 `STORE_CLEAN`（无任何提及 store/types.ts 或 store/index.ts 的错误行）。

- [ ] **Step 4: 提交**

```bash
git add main/helpers/store/types.ts main/helpers/store/index.ts
git commit -m "feat(close): add closeAction/closeHintShown settings schema + defaults"
```

---

## Task 3: taskProcessor 暴露忙碌计数

**Files:**

- Modify: `main/helpers/taskProcessor.ts:82-87`

- [ ] **Step 1: 改写忙碌判断为基于计数**

将 `main/helpers/taskProcessor.ts` 当前第 82-87 行：

```ts
/**
 * 是否有转写任务在执行或排队。供升级/下载 IPC 在运行中拒绝操作（避免 Windows 文件锁）。
 */
export function isTranscriptionBusy(): boolean {
  return activeTasksCount > 0 || processingQueue.length > 0;
}
```

替换为：

```ts
/**
 * 正在执行 + 排队中的转写任务总数。供关闭窗口提示展示「仍在处理 N 个任务」。
 */
export function getTranscriptionBusyCount(): number {
  return activeTasksCount + processingQueue.length;
}

/**
 * 是否有转写任务在执行或排队。供升级/下载 IPC 在运行中拒绝操作（避免 Windows 文件锁）。
 */
export function isTranscriptionBusy(): boolean {
  return getTranscriptionBusyCount() > 0;
}
```

- [ ] **Step 2: 类型门禁（不新增错误）**

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "taskProcessor\.ts" || echo "TP_CLEAN"`
Expected: 输出 `TP_CLEAN`。

- [ ] **Step 3: 提交**

```bash
git add main/helpers/taskProcessor.ts
git commit -m "feat(close): export getTranscriptionBusyCount for close-window prompt"
```

---

## Task 4: windowClose.ts（Electron 装配模块）

**Files:**

- Create: `main/helpers/windowClose.ts`

依赖：Task 1（`decideCloseIntent` / `CloseAction`）、Task 2（settings 键）、Task 3（`getTranscriptionBusyCount`）。

- [ ] **Step 1: 创建模块**

Create `main/helpers/windowClose.ts`：

```ts
import { app, BrowserWindow, dialog } from 'electron';
import { store } from './store';
import { getTranscriptionBusyCount } from './taskProcessor';
import { decideCloseIntent, type CloseAction } from './windowCloseDecision';

type DialogLanguage = 'zh' | 'en';

/** Cmd+Q / 菜单退出 / 我们主动退出时置位：区分「关窗」与「真退出」 */
let isQuitting = false;
/** 防止连点红叉时叠加多个对话框 */
let closePromptOpen = false;

export function getIsQuitting(): boolean {
  return isQuitting;
}

export function markQuitting(): void {
  isQuitting = true;
}

const LABELS: Record<DialogLanguage, Record<string, string>> = {
  zh: {
    bgTitle: '应用仍在后台运行',
    bgDetailBusy:
      '仍在后台处理 %d 个任务。要彻底退出，请用 Cmd+Q 或右键 Dock 图标 → 退出。',
    bgDetailIdle:
      '应用将继续在后台运行。要彻底退出，请用 Cmd+Q 或右键 Dock 图标 → 退出。',
    bgBackground: '转入后台',
    bgQuitNow: '立即退出',
    dontShowAgain: '不再提示',
    quitTitle: '仍有任务在运行',
    quitDetailBusy: '当前还有 %d 个任务正在处理，退出会中断它们。确定退出吗？',
    quitConfirm: '退出',
    cancel: '取消',
  },
  en: {
    bgTitle: 'App keeps running in the background',
    bgDetailBusy:
      'Still processing %d task(s) in the background. To quit completely, use Cmd+Q or right-click the Dock icon → Quit.',
    bgDetailIdle:
      'The app will keep running in the background. To quit completely, use Cmd+Q or right-click the Dock icon → Quit.',
    bgBackground: 'Keep in Background',
    bgQuitNow: 'Quit Now',
    dontShowAgain: "Don't show again",
    quitTitle: 'Tasks still running',
    quitDetailBusy:
      '%d task(s) are still processing. Quitting will interrupt them. Quit anyway?',
    quitConfirm: 'Quit',
    cancel: 'Cancel',
  },
};

function resolveLanguage(): DialogLanguage {
  const settings = store.get('settings') as { language?: string } | undefined;
  if (settings?.language === 'zh' || settings?.language === 'en') {
    return settings.language;
  }
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function resolveCloseAction(): CloseAction {
  const a = (store.get('settings') as { closeAction?: CloseAction } | undefined)
    ?.closeAction;
  return a === 'background' || a === 'quit' ? a : 'smart';
}

/** 二次确认退出：返回 true=用户确认退出 */
function confirmQuit(win: BrowserWindow, count: number): boolean {
  const l = LABELS[resolveLanguage()];
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: [l.quitConfirm, l.cancel],
    defaultId: 1,
    cancelId: 1,
    title: l.quitTitle,
    message: l.quitTitle,
    detail: l.quitDetailBusy.replace('%d', String(count)),
    noLink: true,
  });
  return choice === 0;
}

/**
 * 转入后台：首次弹一次性提示（带「不再提示」+「立即退出」），之后静默隐藏。
 * 返回前已执行 hide 或 app.quit。
 */
async function goBackground(win: BrowserWindow, count: number): Promise<void> {
  const settings = store.get('settings');
  if (settings?.closeHintShown) {
    win.hide();
    return;
  }
  const l = LABELS[resolveLanguage()];
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: [l.bgBackground, l.bgQuitNow],
    defaultId: 0,
    cancelId: 0,
    title: l.bgTitle,
    message: l.bgTitle,
    detail:
      count > 0 ? l.bgDetailBusy.replace('%d', String(count)) : l.bgDetailIdle,
    checkboxLabel: l.dontShowAgain,
    checkboxChecked: false,
    noLink: true,
  });
  if (checkboxChecked) {
    store.set('settings', { ...settings, closeHintShown: true });
  }
  if (response === 1) {
    app.quit();
    return;
  }
  win.hide();
}

async function handleWindowClose(win: BrowserWindow): Promise<void> {
  if (closePromptOpen) return;
  closePromptOpen = true;
  try {
    const count = getTranscriptionBusyCount();
    const intent = decideCloseIntent({
      platform: process.platform,
      closeAction: resolveCloseAction(),
      busy: count > 0,
    });
    if (intent === 'quit') {
      app.quit();
    } else if (intent === 'confirm-quit') {
      if (confirmQuit(win, count)) app.quit();
    } else {
      await goBackground(win, count);
    }
  } finally {
    closePromptOpen = false;
  }
}

/** 装配窗口关闭行为 + Dock 激活恢复（取代 background.ts 内联逻辑） */
export function setupWindowCloseBehavior(mainWindow: BrowserWindow): void {
  mainWindow.on('close', (e) => {
    if (isQuitting) return; // 真退出进行中：放行
    e.preventDefault();
    void handleWindowClose(mainWindow);
  });

  // macOS：点击 Dock 图标恢复窗口
  app.on('activate', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });
}
```

- [ ] **Step 2: 类型门禁（不新增错误）**

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "windowClose\.ts" || echo "WC_CLEAN"`
Expected: 输出 `WC_CLEAN`。

- [ ] **Step 3: 提交**

```bash
git add main/helpers/windowClose.ts
git commit -m "feat(close): windowClose module (dialogs, hide/quit, quit-state, i18n)"
```

---

## Task 5: 接入 background.ts

**Files:**

- Modify: `main/background.ts`（导入区第 23 行附近、`isQuitting`/before-quit 第 77-89 行、close/activate 第 149-162 行）

依赖：Task 4。

- [ ] **Step 1: 加模块导入**

在 `main/background.ts` 第 23 行 `import { setupAppMenu } from './helpers/menu';` 之后追加：

```ts
import { setupWindowCloseBehavior, markQuitting } from './helpers/windowClose';
```

- [ ] **Step 2: before-quit 改用 markQuitting，删除本地 isQuitting**

将当前第 77-89 行：

```ts
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

替换为：

```ts
let runtimeShutdownDone = false;
app.on('before-quit', (event) => {
  // 真退出标记集中在 windowClose 模块，close 监听据此放行
  markQuitting();
  if (!runtimeShutdownDone) {
    event.preventDefault();
    runtimeShutdownDone = true;
    void shutdownPythonRuntime().finally(() => {
      app.exit(0);
    });
  }
});
```

- [ ] **Step 3: 删除内联 close/activate，改用模块装配**

将当前第 149-162 行：

```ts
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

替换为：

```ts
// 关窗行为（macOS 智能模式 / Win·Linux 防误杀）+ Dock 激活恢复
setupWindowCloseBehavior(mainWindow);
```

- [ ] **Step 4: 类型门禁（不新增错误）**

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "background\.ts" || echo "BG_CLEAN"`
Expected: 输出 `BG_CLEAN`（确认无 `isQuitting` 未定义等新错误）。

- [ ] **Step 5: 启动冒烟**

Run: `npm run dev`（启动后观察控制台无报错，窗口正常加载）
Expected: 应用正常启动；`Cmd+Q` 能优雅退出（控制台无未捕获异常）。手动确认后 `Ctrl+C` 结束 dev。

- [ ] **Step 6: 提交**

```bash
git add main/background.ts
git commit -m "feat(close): wire windowClose into background, centralize quit state"
```

---

## Task 6: 渲染层设置 UI + i18n

**Files:**

- Modify: `renderer/pages/[locale]/settings.tsx`
- Modify: `renderer/public/locales/zh/settings.json`
- Modify: `renderer/public/locales/en/settings.json`

- [ ] **Step 1: 加状态与平台判断**

在 `renderer/pages/[locale]/settings.tsx` 的 `const [proxyTesting, setProxyTesting] = useState(false);`（当前第 138 行）之后追加：

```tsx
const [closeAction, setCloseAction] = useState<'smart' | 'background' | 'quit'>(
  'smart',
);
// 关闭行为设置仅 macOS 有意义；用 useEffect 设置避免 SSR/CSR 水合不一致
const [isMac, setIsMac] = useState(false);
useEffect(() => {
  setIsMac(window?.ipc?.platform === 'darwin');
}, []);
```

- [ ] **Step 2: 加载已存设置**

在 `loadSettings` 的 `setProxyNoProxy(settings.proxyNoProxy || '');`（当前第 163 行）之后追加：

```tsx
setCloseAction(settings.closeAction || 'smart');
```

- [ ] **Step 3: 加变更处理函数**

在 `handleVADChange` 函数定义（当前第 258 行 `const handleVADChange = async (checked: boolean) => {`）之前追加：

```tsx
const handleCloseActionChange = async (
  value: 'smart' | 'background' | 'quit',
) => {
  setCloseAction(value);
  try {
    await window?.ipc?.invoke('setSettings', { closeAction: value });
    toast.success(t('closeActionSaved'));
  } catch (error) {
    toast.error(t('saveFailed'));
  }
};
```

- [ ] **Step 4: 在「系统设置」卡片加下拉（仅 macOS）**

在 `settings.tsx` 的「启动时检查更新」区块结束 `</div>`（当前第 464 行）与「临时目录」区块 `<div className="space-y-2">`（当前第 466 行）之间插入：

```tsx
{
  isMac && (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span>{t('closeAction')}</span>
        <HelpHint text={t('closeActionTip')} />
      </div>
      <Select
        value={closeAction}
        onValueChange={(v) =>
          handleCloseActionChange(v as 'smart' | 'background' | 'quit')
        }
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="smart">{t('closeActionSmart')}</SelectItem>
          <SelectItem value="background">
            {t('closeActionBackground')}
          </SelectItem>
          <SelectItem value="quit">{t('closeActionQuit')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 5: 加 zh 文案**

在 `renderer/public/locales/zh/settings.json` 顶层对象内追加以下键（放在 `checkUpdateOnStartup` 相关键附近即可，JSON 键顺序无关）：

```json
  "closeAction": "关闭窗口时",
  "closeActionTip": "智能：有任务在运行时转入后台继续、空闲时直接退出；最小化到后台：关窗后应用始终在后台运行（用 Cmd+Q 或 Dock 右键退出）；退出应用：关窗即退出，若有任务在运行会先二次确认。",
  "closeActionSmart": "智能（推荐）",
  "closeActionBackground": "最小化到后台",
  "closeActionQuit": "退出应用",
  "closeActionSaved": "已保存关闭窗口行为",
```

- [ ] **Step 6: 加 en 文案**

在 `renderer/public/locales/en/settings.json` 顶层对象内追加同名键：

```json
  "closeAction": "Close button behavior",
  "closeActionTip": "Smart: keep running in the background while tasks are active, quit when idle. Keep running in background: the app always stays running after closing the window (quit with Cmd+Q or Dock right-click). Quit the app: closing the window quits; if tasks are running you'll be asked to confirm first.",
  "closeActionSmart": "Smart (recommended)",
  "closeActionBackground": "Keep running in background",
  "closeActionQuit": "Quit the app",
  "closeActionSaved": "Close behavior saved",
```

- [ ] **Step 7: i18n 对等门禁**

Run: `npm run check:i18n`
Expected: 退出码 0（无缺失键报告）。

- [ ] **Step 8: 渲染层类型门禁（不新增错误）**

Run: `npx tsc -p renderer/tsconfig.json --noEmit --incremental false 2>&1 | grep -E "settings\.tsx" || echo "SETTINGS_CLEAN"`
Expected: 输出 `SETTINGS_CLEAN`。

- [ ] **Step 9: 提交**

```bash
git add renderer/pages/[locale]/settings.tsx renderer/public/locales/zh/settings.json renderer/public/locales/en/settings.json
git commit -m "feat(close): add macOS-only close-behavior setting in System Settings"
```

---

## 手动冒烟矩阵（实现完成后逐格验证）

启动 `npm run dev`，覆盖：

- [ ] **macOS·智能·有任务**：开始一个转写任务 → 点红叉 → 首次弹「应用仍在后台运行」对话框（含「不再提示」+「立即退出」）→ 选「转入后台」→ 窗口隐藏、Dock 图标仍在、任务继续；点 Dock 图标窗口恢复。
- [ ] **macOS·智能·空闲**：无任务 → 点红叉 → 直接退出（无对话框）。
- [ ] **首次提示只一次**：再次「有任务关窗」不再弹对话框，直接隐藏；勾过「不再提示」后亦然。
- [ ] **立即退出**：首次对话框点「立即退出」→ 应用退出（控制台显示走了 before-quit 优雅关闭）。
- [ ] **macOS·始终后台**：设置切「最小化到后台」→ 空闲关窗也隐藏（首次弹一次提示）。
- [ ] **macOS·始终退出·有任务**：设置切「退出应用」→ 有任务关窗 → 弹「仍有任务在运行」二次确认 → 取消则窗口留存、确定则退出。
- [ ] **Cmd+Q**：任意设置下 `Cmd+Q` 始终优雅退出。
- [ ] **Win/Linux（如可测）**：有任务关窗 → 二次确认拦下；空闲关窗 → 退出；设置页**不显示**「关闭窗口时」。
- [ ] **连点红叉**：快速连点不叠加多个对话框。
- [ ] **语言切换**：设置切英文后，关窗对话框文案为英文。

---

## Self-Review（plan 对 spec 覆盖核对）

- spec §1.3 决策（行为模型 A / 平台 B / 提示 A / 设置形态）→ Task 1（矩阵）+ Task 4（提示/确认）+ Task 6（设置）✔
- spec §2 行为矩阵 → Task 1 单测逐格固化 + Task 4 执行映射 ✔
- spec §3 复用 `isTranscriptionBusy` 并加计数 → Task 3 ✔
- spec §4 设置模型 `closeAction`/`closeHintShown` → Task 2 ✔
- spec §5 主进程（退出状态集中、close 决策、首次提示、二次确认、i18n）→ Task 4 + Task 5 ✔
- spec §6 渲染层设置（仅 macOS、window.ipc.platform、System Settings 下拉、i18n）→ Task 6 ✔
- spec §7 边界（防重复弹窗 closePromptOpen、自动更新经 app.quit 放行、window-all-closed 维持、语义隔离）→ Task 4（`closePromptOpen`、`markQuitting`）+ Task 5（保留 window-all-closed）✔
- spec §8 验证（renderer tsc / 主进程过滤 / check:i18n / 手动矩阵）→ 各 Task 门禁 + 手动冒烟矩阵 ✔
- 类型一致性：`CloseAction`/`CloseIntent` 在 Task 1 定义，Task 4 复用同名；`getTranscriptionBusyCount` 在 Task 3 定义、Task 4 引用；`markQuitting`/`getIsQuitting` 在 Task 4 定义、Task 5 引用 ✔
- 占位符扫描：无 TBD/TODO，每个代码步含完整代码与确切命令 ✔
