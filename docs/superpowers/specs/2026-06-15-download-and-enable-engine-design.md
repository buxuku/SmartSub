# 下载并启用引擎设计（faster-whisper 下载后自动设为当前引擎）

> 状态：已评审（待写实现计划）
> 日期：2026-06-15
> 范围：faster-whisper 引擎「下载完成 → 自动设为当前引擎」，仅首次安装且任务空闲时生效；安装按钮改名「下载并启用」
> 关联：`renderer/components/resources/EnginesTab.tsx`、`renderer/public/locales/{zh,en}/resources.json`、`main/helpers/ipcEngineHandlers.ts`（复用，不改）

---

## 1. 背景与目标

faster-whisper 引擎当前是「下载」与「启用」两步：下载完成 → 检测中 → 「可用」，但**不会自动成为当前引擎**；用户还要再点一次「设为当前引擎」才能真正用上。下载引擎的主导意图就是「我要用它」，多出来的这一步容易让人困惑——「我装好了，为什么任务还在跑 builtin」，这正是 T1「下载完界面没明显变化」那类落差的延续。

**目标**：把首次安装收敛成一步——下载 + 冷启动检测通过后，**自动设为当前引擎**，并把安装按钮文案改为「下载并启用」让行为可预期。

**非目标 / 收窄**：

- 升级（`handleUpgrade`）不切换当前引擎——用户只想升级，不该被悄悄换引擎。
- 修复（`fasterBroken` → 重新下载）不切换——修复一个坏引擎不应抢占当前选择。
- 任务运行中（`taskBusy`）不自动切——沿用现有「运行中禁止切换引擎」的约束，仅给提示。
- 不动 builtin（内置无需下载）与 localCli（无引擎下载）。

---

## 2. 现状

`EnginesTab.tsx` 关键路径：

- **下载完成监听**（`py-engine-download-progress` 的 `completed` 分支，约 143–158 行）：`setVerifying(true)` → `await python-engine:ping`（冷启动校验）→ `refresh()` → 清 `verifying`。**全程不碰 `currentEngine`**。
- **设为当前**（`handleSelectEngine`，约 181–205 行）：忙碌时 `toast(switchBlocked)` 拦截；否则 `invoke('set-transcription-engine', engine)`，成功后 `setCurrentEngine` + 派发 `transcription-engine-changed`；若返回 `engine_not_installed` → `setShowDownloadConfirm(true)`。
- **安装入口**（`handleStartDownload`，约 216–229 行）：`invoke('start-py-engine-download')`。安装按钮（约 670–684 行）与**修复按钮**（`fasterBroken`，约 685–694 行）**都**走 `setShowDownloadConfirm(true)` → `handleStartDownload`，且产生**同一个** `completed` 事件——故无法靠「哪个 handler 跑了」区分安装 / 修复。
- **升级入口**（`handleUpgrade`，约 258–271 行）：同样 `invoke('start-py-engine-download')`，也产生同一个 `completed`。
- **忙碌状态**：`taskBusy` 由 `refresh()`（约 131 行）与 `taskStatusChange` 监听（约 167–169 行）写入。

主进程 `set-transcription-engine`（`main/helpers/ipcEngineHandlers.ts:38–65`）：

- 仅在 `engine === 'fasterWhisper' && !isPyEngineInstalled()` 时返回 `engine_not_installed`；**不**校验任务忙碌。
- 写入 `settings.transcriptionEngine` / `useLocalWhisper`，并在切到 fasterWhisper 时 `ensureStarted()` 预热 sidecar。

**结论**：忙碌守卫只在渲染端存在 → 自动启用必须在渲染端自己判断忙碌；且下载进度监听器闭包里的 `taskBusy` 是注册时的旧值，不能直接用。

---

## 3. 方案

### 3.1 意图标记 `pendingActivate`（区分安装 / 升级 / 修复）

新增 `const pendingActivateRef = useRef(false)`，在每个下载入口**显式置位**：

| 入口                                                | `pendingActivate` | 理由                     |
| --------------------------------------------------- | ----------------- | ------------------------ |
| 安装按钮 onClick                                    | `true`            | 装它就是要用它           |
| `handleSelectEngine` 的 `engine_not_installed` 分支 | `true`            | 用户本就在点「设为当前」 |
| 修复按钮 onClick（`fasterBroken`）                  | `false`           | 修复不抢占当前引擎       |
| `handleUpgrade`                                     | `false`           | 升级不切换当前引擎       |

> 在 click / 分支处置位（而非在 `handleStartDownload` 内反推 `fasterInstalled/fasterBroken`），可避免源码顺序 / 闭包旧值带来的歧义，意图最清晰。

### 3.2 完成时行为（`completed` 分支，`ping` 成功后）

把现有 `completed` 分支的 ping 改为记录成功与否，并在 `refresh()` 之后追加自动启用：

```tsx
setVerifying(true);
setUpdateInfo(null);
(async () => {
  let pingOk = false;
  try {
    const r = await window?.ipc?.invoke('python-engine:ping');
    pingOk = !!r?.success;
  } catch {
    // 校验失败：交给 refresh() 反映真实状态（broken → 修复入口）
  } finally {
    await refresh();
    setVerifying(false);
  }
  // 下载并启用：仅首次安装意图、检测通过、且任务空闲时，自动设为当前引擎
  if (pendingActivateRef.current && pingOk) {
    if (taskBusyRef.current) {
      toast(t('engines.fasterWhisper.downloadedBusyHint'));
    } else {
      const r = await window?.ipc?.invoke(
        'set-transcription-engine',
        'fasterWhisper',
      );
      if (r?.success) {
        setCurrentEngine('fasterWhisper');
        window.dispatchEvent(new CustomEvent('transcription-engine-changed'));
      }
    }
  }
  pendingActivateRef.current = false;
})();
```

- `pingOk` 守住「装完即坏」的情况（broken 不应被设为当前）。
- 忙碌：不切换，只 toast 提示；用户任务结束后仍可手动「设为当前引擎」（按钮仍在）。
- 复用 `set-transcription-engine`：它会顺带 `ensureStarted()` 预热，刚 ping 过通常已热，成本低。
- 末尾无条件复位 `pendingActivateRef`，避免下次升级/修复误触发。

### 3.3 忙碌状态用 ref 读最新值

下载进度监听器在 `useEffect([refresh, t])` 内注册，闭包里的 `taskBusy` 是旧值。新增 `const taskBusyRef = useRef(false)`，在已有写 `setTaskBusy` 的两处同步：

- `refresh()` 里：`setTaskBusy(b); taskBusyRef.current = b;`
- `taskStatusChange` 监听里：`const b = isQueueBusy(status); setTaskBusy(b); taskBusyRef.current = b;`

`completed` 分支读 `taskBusyRef.current` 即为最新忙碌态。

### 3.4 按钮文案

安装按钮复用现有 key `engines.fasterWhisper.download`，仅改**文案值**：

- zh：`下载引擎（约 {{size}}）` → `下载并启用（约 {{size}}）`
- en：`Download engine (~{{size}})` → `Download & enable (~{{size}})`

修复按钮文案（`engines.fasterWhisper.repair`「修复 / Repair」）不变——修复语义不含启用。

新增忙碌提示 key `engines.fasterWhisper.downloadedBusyHint`：

- zh：`引擎已下载完成；当前有任务在运行，结束后可在此「设为当前引擎」。`
- en：`Engine downloaded. A task is running — you can set it as current here once it finishes.`

---

## 4. 边界与坑

- **闭包旧值**：`taskBusy` / 必须经 `taskBusyRef` 读最新值；`currentEngine` 在首次安装时不可能是 `fasterWhisper`，故不依赖其新鲜度（且 `set-transcription-engine` 幂等）。
- **主进程不拦忙碌**：忙碌判断完全在渲染端；本设计已在 `completed` 分支前置 `taskBusyRef` 判断。
- **`engine_not_installed` 路径**：`handleSelectEngine` 顶部已有 `taskBusy` 拦截，忙碌时根本到不了下载确认，与本设计不冲突。
- **修复成功后**：若被修复的引擎本来就是当前引擎，它仍是当前引擎（无需切换）；若不是，保持不变——符合「修复不抢占」。
- **下载确认弹窗文案**：仍为通用「下载 / 体积 / 源」说明，不随按钮改名而改（保持范围最小）。
- **取消下载**：不会产生 `completed`，`pendingActivateRef` 不被消费；下次任一入口会重新置位，无残留风险。

---

## 5. 受影响文件

| 文件                                           | 改动                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `renderer/components/resources/EnginesTab.tsx` | 新增 `pendingActivateRef` / `taskBusyRef`；各入口置位；`completed` 分支加自动启用 + 忙碌提示 |
| `renderer/public/locales/zh/resources.json`    | `download` 文案改「下载并启用」；新增 `downloadedBusyHint`                                   |
| `renderer/public/locales/en/resources.json`    | `download` 文案改「Download & enable」；新增 `downloadedBusyHint`                            |
| `main/helpers/ipcEngineHandlers.ts`            | **0 改动**（复用 `set-transcription-engine`，其已含预热）                                    |

---

## 6. 测试策略

### 6.1 门禁

- **Renderer typecheck**：`npx tsc -p renderer/tsconfig.json --noEmit --incremental false`，`EnginesTab` 不得出现在新错误里（沿用 task-ux-batch 计划的 scoped 基线 184）。
- **i18n 对等**：`node scripts/check-i18n.mjs` 无缺失/多余键（zh/en 均加 `downloadedBusyHint`）。

### 6.2 手动验证矩阵

| 场景                                        | 期望                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| 全新（未装）+ 空闲 → 点「下载并启用」       | 进度 → 检测中 → 可用，**自动**变「使用中」，头部引擎指示器同步切到 fw     |
| 「设为当前」点未安装引擎 → 确认下载（空闲） | 下载完成后自动设为当前                                                    |
| 下载时有 builtin 任务在跑（忙碌）           | 下载完成 → 不切换，toast 提示「任务结束后可设为当前」；任务结束后手动可切 |
| 已装、点「升级」                            | 升级完成后当前引擎**不变**                                                |
| broken、点「修复」                          | 修复完成后当前引擎**不变**（修复前是谁还是谁）                            |
| 装完即坏（ping 失败）                       | 不自动启用，落到 broken / 修复入口                                        |
