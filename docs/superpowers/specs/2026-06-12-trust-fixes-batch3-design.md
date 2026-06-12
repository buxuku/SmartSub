# 信任修复 · 批次 3「平台与交互兼容」设计

> 上游：`docs/UX_ANALYSIS_REPORT.md` Phase 1；批次切分见 batch1 设计 §7。
> 范围：P0#8、P0#9、P0#10、P1#22、P1#23。批次 1/2 已完成。
> 备注：用户授权本批次自主执行（设计自检后直接实施，13:05 统一汇报验收）。

## 1. 问题与目标

| #     | 问题                                                                                              | 目标                                                 |
| ----- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P0#8  | 拖拽取路径依赖 `File.path`（Electron 32+ 已移除），升级即静默坏                                   | 迁移 `webUtils.getPathForFile()`，preload 暴露       |
| P0#9  | ProvidersTab 首项为自定义服务商时选中 `.type`（'openai'）匹配不到任何 `provider.id`，右侧面板空白 | 默认选中改用 `.id`                                   |
| P0#10 | macOS 关窗即 `app.quit()`，过夜批量任务被误关窗杀光；任务进行中无 Dock 进度                       | 关窗隐藏保活（Cmd+Q 真退出）+ 任务文件级 Dock 进度条 |
| P1#22 | 危险操作裸执行：任务页清空列表、删自定义服务商、校对删行/重置                                     | `useConfirmOrUndo` hook：立即执行 + 5 秒撤销 toast   |
| P1#23 | 即改即存反馈失控：VAD 数字输入每击键保存+toast；ProvidersTab 每字符一次 IPC                       | debounce 500ms 持久化；成功静默、失败才 toast        |

## 2. 技术设计

### 2.1 P0#8 webUtils 迁移

**main/preload.ts**：import `webUtils`，handler 增加：

```ts
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
```

`window.ipc` 类型经 `IpcHandler` 自动透出（renderer/preload.d.ts 引用 typeof handler）。

**home.tsx L195-203 / tasks/[type].tsx L246-254**：取路径改为

```ts
const filePath =
  window?.ipc?.getPathForFile?.(droppedFiles[i]) ??
  (droppedFiles[i] as any).path;
```

保留 `.path` 兜底：开发态 preload 热更新滞后时拖拽不至于全断；Electron 30 当前两者皆可用。移除 `@ts-ignore`。

### 2.2 P0#9 默认选中

`ProvidersTab.loadProviders`：`setSelectedProvider(storedProviders[0].type)` → `storedProviders[0].id`。内置服务商 id===type 行为不变；自定义服务商修复为选中存在的面板。

### 2.3 P0#10 macOS 关窗保活 + Dock 进度

**background.ts**：

```ts
let isQuitting = false;
app.on('before-quit', () => {
  isQuitting = true;
});
// 创建 mainWindow 后：
mainWindow.on('close', (e) => {
  if (process.platform === 'darwin' && !isQuitting) {
    e.preventDefault();
    mainWindow.hide(); // 关窗=隐藏，任务继续；Cmd+Q/退出菜单真退出
  }
});
app.on('activate', () => {
  mainWindow?.show();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

**taskProcessor.ts Dock/任务栏进度**（文件粒度，跨工程聚合）：

- `ProjectRuntime` 增 `total: number; completed: number`；
- `handleTask`：`runtime.total += files.length`；
- 每文件 finally：`runtime.completed++`；
- `cancelTask` 清队列：`runtime.total -= 移除数`；
- `updateTaskbarProgress(mainWindow)`：聚合全部 runtime，`total===0 ? setProgressBar(-1) : setProgressBar(completed/total)`；在上述每个变更点与 finalize 后调用；窗口销毁时跳过。`setProgressBar` 同时覆盖 macOS Dock 与 Windows 任务栏。

### 2.4 P1#22 useConfirmOrUndo

新 hook `renderer/hooks/useConfirmOrUndo.ts`：「立即执行 + 5 秒撤销」模式（Linear/Notion 式，免打断）：

```ts
export function useConfirmOrUndo() {
  const { t } = useTranslation('common');
  return useCallback(
    (message: string, undo: () => void) => {
      toast(message, {
        action: { label: t('undo') || '撤销', onClick: undo },
        duration: 5000,
      });
    },
    [t],
  );
}
```

调用方先快照旧状态 → 应用变更 → 调 hook 给撤销机会。接入点：

1. **tasks/[type].tsx `handleClearList`**：快照 files；空列表不弹；
2. **ProvidersTab `handleRemoveProvider`**：快照 providers + 选中态；undo 恢复数组并重发 `setTranslationProviders`、恢复选中；删除的是当前选中项时改选第一个内置项；
3. **proofread.tsx `handleRemoveFile`**：快照被删项与位置，undo 原位插回；
4. **proofread.tsx `handleReset`**：快照 pendingFiles/savedTaskId/taskName/importType/stage，undo 全量恢复。

首页删工程已有 AlertDialog 确认，维持不动（删的是持久化工程，模态确认合理）。

i18n：common.json 增 `undo`；tasks.json 增 `listCleared`；translateControl.json 增 `providerRemoved`（带 {{name}} 插值）；home.json 增 `fileRemoved`、`importReset`。zh/en 同步。

### 2.5 P1#23 保存降噪

**settings.tsx VAD 数字输入**：`handleVADSettingChange` 改为：本地 state 立即更新；待存项合入 `pendingVadRef`，500ms 静默期后一次 `setSettings` 批量提交；成功静默（去掉 toast.success），失败 `toast.error`。开关类（useVAD 等离散操作）保持原即时保存+toast 不动。

**ProvidersTab `handleInputChange`**：`setProviders` 立即；`setTranslationProviders` IPC 改 500ms debounce（ref 计时器 + 最新值引用），组件卸载时 flush，避免最后一击键丢失。

## 3. 错误处理

- `getPathForFile` 抛错（非文件对象等）→ `??` 链回退 `.path`，再为空则跳过该项（与现状一致）；
- Dock 进度更新包 try/catch + `isDestroyed()` 守卫，失败仅日志；
- 撤销 toast 超时未点击即定局（状态已变更、无额外清理）；
- debounce 保存失败：`toast.error`，本地 state 保持用户输入（与现状一致，不回滚）。

## 4. 验收清单（人工）

1. 拖拽视频到首页任务卡/任务页拖放区，文件正常入列（迁移后行为不变）；
2. 资源中心-服务商：把自定义服务商排到首位（或仅剩自定义时）进入页面，右侧面板正确显示该服务商配置；
3. macOS：任务运行中关窗 → 应用不退出（Dock 图标在），任务继续跑；Dock 图标点击恢复窗口；Cmd+Q 正常退出；任务运行中 Dock 图标出现进度条，全部完成后消失；
4. 任务页「清空列表」→ 列表立即清空 + 出现 5 秒撤销 toast，点撤销恢复；删自定义服务商、校对列表删行、重新导入同理；
5. 设置页 VAD 输入「0.25」一类多次击键 → 不再连环 toast，停止输入 0.5s 后静默保存（重开设置页值在）；服务商表单连续输入不再每字符发 IPC。

## 5. 非目标

- 深暂停（阶段边界暂停，用户已确认维持现状，归 Phase 2 状态机重构）；
- 托盘图标、防睡眠（powerSaveBlocker）、菜单本地化（P1#34/P2 范畴）；
- 首页删工程确认方式改造（已有 AlertDialog，合理）；
- 测试翻译语向写死 en→zh（P1 单独项，未列入本批）。
