# 信任修复 · 批次 1「任务执行语义重构」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取消/暂停按工程真正生效（kill ffmpeg + 翻译令牌中断 + 转写完成即停）、任务状态与日志按工程隔离、修复「全部已处理」误判。

**Architecture:** 保留共享队列 + 全局并发池，队列项打 `projectId` 标签；主进程用 `AsyncLocalStorage` 携带 `{projectId, fileUuid, signal}` 任务上下文，日志自动打标、翻译循环在批次边界检查中断信号；ffmpeg 进程入注册表可 kill；whisper 原生调用不可中断，在阶段边界检查取消标记善后。

**Tech Stack:** Electron 主进程（Node `async_hooks.AsyncLocalStorage`、`AbortController`、fluent-ffmpeg `kill()`）+ Next.js 渲染层（React/shadcn）+ next-i18next。

**上游设计：** `docs/superpowers/specs/2026-06-12-trust-fixes-batch1-design.md`

**验证门禁（每个 Task 末尾执行）：**

> 执行期修正：仓库存在 590 个存量 tsc 错误（docs/ Docusaurus 类型冲突、`__tests__` 缺 jest 类型、main/service 4 个遗留文件 67 个），「0 错误」门禁不成立。
> 改为「**不新增错误**」门禁，基线快照已存 `/tmp/tsc-baseline-mainonly.txt`（main 非测试 67 条）。

```bash
# 主进程门禁：对比基线，必须无新增（输出为空）
npx tsc --noEmit 2>/dev/null | grep "error TS" | grep -v "^docs/" | grep -v "^renderer/" | grep -v "__tests__" | sort > /tmp/tsc-now-main.txt; comm -13 /tmp/tsc-baseline-mainonly.txt /tmp/tsc-now-main.txt

# 渲染层门禁：非测试文件错误必须为 0（输出为空）
npx tsc --noEmit -p renderer/tsconfig.json 2>/dev/null | grep "error TS" | grep -v "__tests__"
```

两条命令输出都必须为空。仓库无可用测试框架（设计决策：不引入），以类型检查 + 人工验收为门禁。

---

## Task 1: 任务上下文模块（taskContext）+ 日志打标

**Files:**

- Create: `main/helpers/taskContext.ts`
- Modify: `main/helpers/store/types.ts`（LogEntry 加 projectId）
- Modify: `main/helpers/logger.ts`（写日志时自动取上下文）
- Modify: `main/helpers/ipcStoreHandlers.ts:90-92`（getLogs 支持按工程过滤）

- [ ] **Step 1.1: 新建 `main/helpers/taskContext.ts`**

```ts
import { AsyncLocalStorage } from 'async_hooks';

export interface TaskRunContext {
  projectId?: string;
  fileUuid?: string;
  /** 取消信号：翻译批次边界与阶段边界检查 */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<TaskRunContext>();

/** 在任务上下文中执行：logMessage 自动打 projectId 标，取消检查可感知 signal */
export function runWithTaskContext<T>(
  context: TaskRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function getTaskContext(): TaskRunContext | undefined {
  return storage.getStore();
}

const CANCEL_MESSAGE = 'TASK_CANCELLED';

export class TaskCancelledError extends Error {
  constructor() {
    super(CANCEL_MESSAGE);
    this.name = 'TaskCancelledError';
  }
}

export function isTaskCancelledError(error: unknown): boolean {
  return (
    error instanceof TaskCancelledError ||
    (error instanceof Error && error.message === CANCEL_MESSAGE)
  );
}

export function isTaskCancelled(): boolean {
  return Boolean(storage.getStore()?.signal?.aborted);
}

export function throwIfTaskCancelled(): void {
  if (isTaskCancelled()) throw new TaskCancelledError();
}
```

- [ ] **Step 1.2: `main/helpers/store/types.ts` — LogEntry 加可选 projectId**

把：

```ts
export type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
};
```

改为：

```ts
export type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
  /** 任务工程日志归属；系统日志（updater 等）无此字段 */
  projectId?: string;
};
```

- [ ] **Step 1.3: `main/helpers/logger.ts` — 写日志自动取上下文 projectId**

整文件改为：

```ts
import { BrowserWindow } from 'electron';
import { store } from './store';
import { LogEntry } from './store/types';
import { sanitizeLogMessage } from './utils';
import { getTaskContext } from './taskContext';

export function logMessage(
  message: string | Error,
  type: 'info' | 'error' | 'warning' = 'info',
) {
  const logs = store.get('logs');
  const messageStr =
    message instanceof Error ? message.message : String(message);

  // 对日志消息进行脱敏处理，防止泄露敏感信息
  const sanitizedMessage = sanitizeLogMessage(messageStr);

  const projectId = getTaskContext()?.projectId;
  const newLog: LogEntry = {
    message: sanitizedMessage,
    type,
    timestamp: Date.now(),
    ...(projectId ? { projectId } : {}),
  };
  store.set('logs', [...logs, newLog]);

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('newLog', newLog);
  });
}
```

- [ ] **Step 1.4: `main/helpers/ipcStoreHandlers.ts` — getLogs 支持过滤**

把：

```ts
ipcMain.handle('getLogs', async () => {
  return store.get('logs');
});
```

改为：

```ts
ipcMain.handle('getLogs', async (event, projectId?: string) => {
  const logs = store.get('logs') || [];
  if (!projectId) return logs;
  return logs.filter((log) => log.projectId === projectId);
});
```

- [ ] **Step 1.5: 类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: 0 err误（两条均通过）

- [ ] **Step 1.6: Commit**

```bash
git add main/helpers/taskContext.ts main/helpers/store/types.ts main/helpers/logger.ts main/helpers/ipcStoreHandlers.ts
git commit -m "feat(tasks): add task run context with project-scoped logging"
```

---

## Task 2: ffmpeg 进程注册表与取消 kill

**Files:**

- Modify: `main/helpers/audioProcessor.ts`

- [ ] **Step 2.1: 重写 `extractAudio`，注册 command、取消时按取消路径 reject、清理半成品 wav**

`main/helpers/audioProcessor.ts` 整文件改为：

```ts
import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { logMessage } from './storeManager';
import { getMd5, ensureTempDir, timemarkToSeconds } from './fileUtils';
import { getTaskContext, TaskCancelledError } from './taskContext';

// 设置ffmpeg路径
const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegPath);

/** 正在运行的提取进程：fileUuid -> fluent-ffmpeg command（取消时 kill） */
const runningCommands = new Map<string, ReturnType<typeof ffmpeg>>();

/** 取消时终止指定文件的 ffmpeg 提取进程 */
export function killFfmpegForFiles(fileUuids: string[]) {
  for (const uuid of fileUuids) {
    const command = runningCommands.get(uuid);
    if (!command) continue;
    try {
      command.kill('SIGKILL');
      logMessage(
        `ffmpeg extraction killed for cancelled file ${uuid}`,
        'warning',
      );
    } catch (error) {
      logMessage(`ffmpeg kill failed: ${error}`, 'warning');
    }
    runningCommands.delete(uuid);
  }
}

/**
 * 使用ffmpeg提取音频
 */
export const extractAudio = (
  videoPath,
  audioPath,
  event = null,
  file = null,
) => {
  const onProgress = (percent = 0) => {
    const safePercent = Math.min(Math.max(Math.round(percent), 0), 100);
    logMessage(`extract audio progress ${safePercent}%`, 'info');
    if (event && file) {
      event.sender.send(
        'taskProgressChange',
        file,
        'extractAudio',
        safePercent,
      );
    }
  };
  // 同步捕获上下文：回调里不依赖 ALS 跨 emitter 传播
  const taskContext = getTaskContext();
  const fileUuid = file?.uuid || taskContext?.fileUuid;
  const signal = taskContext?.signal;

  const unregister = () => {
    if (fileUuid) runningCommands.delete(fileUuid);
  };

  return new Promise((resolve, reject) => {
    // fluent-ffmpeg 的 progress.percent 在部分平台/新版 ffmpeg 上恒为 undefined，
    // 这里从 codecData 拿到媒体总时长，再用 progress.timemark 自算百分比（issue #291）。
    let totalDurationSec = 0;
    try {
      const command = ffmpeg(`${videoPath}`)
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .outputOptions('-y')
        .on('start', function (str) {
          onProgress(0);
          logMessage(`extract audio start ${str}`, 'info');
        })
        .on('codecData', function (data) {
          totalDurationSec = timemarkToSeconds(data?.duration);
        })
        .on('progress', function (progress) {
          let percent = progress.percent;
          if (
            (percent === undefined ||
              percent === null ||
              Number.isNaN(percent) ||
              percent <= 0) &&
            totalDurationSec > 0 &&
            progress.timemark
          ) {
            percent =
              (timemarkToSeconds(progress.timemark) / totalDurationSec) * 100;
          }
          onProgress(percent || 0);
        })
        .on('end', function (str) {
          unregister();
          logMessage(`extract audio done!`, 'info');
          onProgress(100);
          resolve(true);
        })
        .on('error', function (err) {
          unregister();
          if (signal?.aborted) {
            // 用户取消导致的 kill：清理半成品，按取消路径返回
            try {
              if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            } catch (cleanupErr) {
              logMessage(
                `cleanup partial audio failed: ${cleanupErr}`,
                'warning',
              );
            }
            logMessage(`extract audio cancelled`, 'warning');
            reject(new TaskCancelledError());
            return;
          }
          logMessage(`extract audio error: ${err}`, 'error');
          reject(err);
        });
      if (fileUuid) runningCommands.set(fileUuid, command);
      command.save(`${audioPath}`);
    } catch (err) {
      unregister();
      logMessage(`ffmpeg extract audio error: ${err}`, 'error');
      reject(`${err}: ffmpeg extract audio error!`);
    }
  });
};

/**
 * 从视频中提取音频
 */
export async function extractAudioFromVideo(event, file) {
  const { filePath } = file;
  event.sender.send('taskFileChange', { ...file, extractAudio: 'loading' });
  const tempDir = ensureTempDir();

  logMessage(`tempDir: ${tempDir}`, 'info');
  const md5FileName = getMd5(filePath);
  const tempAudioFile = path.join(tempDir, `${md5FileName}.wav`);
  file.tempAudioFile = tempAudioFile;

  if (fs.existsSync(tempAudioFile)) {
    logMessage(`Using existing audio file: ${tempAudioFile}`, 'info');
    event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });
    return tempAudioFile;
  }

  await extractAudio(filePath, tempAudioFile, event, file);
  event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });
  return tempAudioFile;
}
```

- [ ] **Step 2.2: 类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: 0 错误

- [ ] **Step 2.3: Commit**

```bash
git add main/helpers/audioProcessor.ts
git commit -m "feat(tasks): make ffmpeg extraction killable on cancel with partial-file cleanup"
```

---

## Task 3: 翻译链路取消检查

**Files:**

- Modify: `main/translate/services/ai.ts`（批次循环边界检查 + 取消错误直抛）
- Modify: `main/translate/services/api.ts`（同上）
- Modify: `main/translate/index.ts`（取消错误不发 message toast）

- [ ] **Step 3.1: `main/translate/services/ai.ts`**

在文件头部 import 区追加：

```ts
import {
  throwIfTaskCancelled,
  isTaskCancelledError,
} from '../../helpers/taskContext';
```

`handleAIBatchTranslation` 的 `for (let i = 0; i < subtitles.length; i += batchSize) {` 循环体第一行（声明 `const batch` 之前）插入：

```ts
throwIfTaskCancelled();
```

`while (!batchSuccess && retryCount <= maxRetries) {` 循环体第一行（`try {` 之前）插入：

```ts
throwIfTaskCancelled();
```

该 while 体内只有一个 `} catch (error) {`（即包含 `isConfigurationError(error)` 检查的那个，约 L157；文件下方 `parseJsonWithFallbacks` 里的 catch 不要动）。在其第一行、`isConfigurationError` 检查之前插入（避免取消被当成翻译失败重试/兜底）：

```ts
if (isTaskCancelledError(error)) throw error;
```

- [ ] **Step 3.2: `main/translate/services/api.ts`**

同样处理：头部追加同一行 import；`for` 循环体第一行插入 `throwIfTaskCancelled();`；`while (!batchSuccess && retryCount <= maxRetries) {` 体第一行插入 `throwIfTaskCancelled();`；其 `} catch (error) {` 第一行插入：

```ts
if (isTaskCancelledError(error)) throw error;
```

（注意放在 `isConfigurationError(error)` 检查之前。）

- [ ] **Step 3.3: `main/translate/index.ts` — 取消不弹错误 toast**

头部追加：

```ts
import { isTaskCancelledError } from '../helpers/taskContext';
```

把 `translate()` 末尾的：

```ts
  } catch (error) {
    event.sender.send('message', error.message || error);
    throw error;
  }
```

改为：

```ts
  } catch (error) {
    if (!isTaskCancelledError(error)) {
      event.sender.send('message', error.message || error);
    }
    throw error;
  }
```

- [ ] **Step 3.4: 类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: 0 错误

- [ ] **Step 3.5: Commit**

```bash
git add main/translate/services/ai.ts main/translate/services/api.ts main/translate/index.ts
git commit -m "feat(tasks): abort translation loops at batch boundaries on cancel"
```

---

## Task 4: fileProcessor 阶段边界取消处理

**Files:**

- Modify: `main/helpers/fileProcessor.ts`

- [ ] **Step 4.1: 头部 import 追加**

```ts
import {
  throwIfTaskCancelled,
  isTaskCancelled,
  isTaskCancelledError,
  TaskCancelledError,
} from './taskContext';
```

- [ ] **Step 4.2: `translateSubtitle` 的 catch 区分取消**

把：

```ts
  } catch (error) {
    // 确保错误状态下也发送当前进度（从文件状态获取）
    onError(event, file, 'translateSubtitle', error);
  }
```

改为：

```ts
  } catch (error) {
    if (isTaskCancelledError(error) || isTaskCancelled()) {
      // 用户取消：翻译阶段回退为待处理，不计错误，并中止后续流程
      event.sender.send('taskFileChange', {
        ...file,
        translateSubtitle: '',
        translateSubtitleProgress: 0,
      });
      throw new TaskCancelledError();
    }
    // 确保错误状态下也发送当前进度（从文件状态获取）
    onError(event, file, 'translateSubtitle', error);
  }
```

- [ ] **Step 4.3: `processFile` 提取/转写段的取消处理**

把（提取音频 + 生成字幕 try 块的 catch）：

```ts
      } catch (error) {
        // 如果是提取音频或生成字幕过程中出错，已经在各自的函数中处理了错误状态
        // 这里只需要继续抛出错误，中断后续流程
        throw error;
      }
```

改为：

```ts
      } catch (error) {
        if (isTaskCancelledError(error) || isTaskCancelled()) {
          // 用户取消：把本轮 loading 阶段回退为待处理
          event.sender.send('taskFileChange', {
            ...file,
            extractAudio: '',
            extractSubtitle: '',
          });
          throw new TaskCancelledError();
        }
        // 如果是提取音频或生成字幕过程中出错，已经在各自的函数中处理了错误状态
        // 这里只需要继续抛出错误，中断后续流程
        throw error;
      }
```

并在该 try 块内，`await extractAudioFromVideo(event, file)` 的结果赋值行之前插入一行、`await generateSubtitle(...)` 调用之前插入一行边界检查（防止取消命中在两阶段之间的间隙后仍进入不可中断的转写）：

`const tempAudioFile = await extractAudioFromVideo(event, file);` 前插入：

```ts
throwIfTaskCancelled();
```

`await generateSubtitle(event, file, formData, hasOpenAiWhisper);` 前插入：

```ts
throwIfTaskCancelled();
```

- [ ] **Step 4.4: 翻译阶段入口边界检查（whisper 完成后即停的关键点）**

把：

```ts
// 翻译字幕
if (shouldTranslateSubtitle && translateProvider !== '-1') {
  logMessage(`translate subtitle ${file.srtFile}`, 'info');
  await translateSubtitle(event, file, formData, provider);
}
```

改为：

```ts
// 翻译字幕（取消后不再进入：转写中取消的文件在此停下，已出的转写结果保留）
throwIfTaskCancelled();
if (shouldTranslateSubtitle && translateProvider !== '-1') {
  logMessage(`translate subtitle ${file.srtFile}`, 'info');
  await translateSubtitle(event, file, formData, provider);
}
```

- [ ] **Step 4.5: `processFile` 最外层 catch 静默处理取消**

把：

```ts
  } catch (error) {
    // 使用通用错误处理方法
    createMessageSender(event.sender).send('message', {
      type: 'error',
      message: error,
    });
  }
```

改为：

```ts
  } catch (error) {
    if (isTaskCancelledError(error) || isTaskCancelled()) {
      logMessage(`processing cancelled: ${file.fileName}`, 'warning');
      return;
    }
    // 使用通用错误处理方法
    createMessageSender(event.sender).send('message', {
      type: 'error',
      message: error,
    });
  }
```

- [ ] **Step 4.6: 类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: 0 错误

- [ ] **Step 4.7: Commit**

```bash
git add main/helpers/fileProcessor.ts
git commit -m "feat(tasks): stop file pipeline at stage boundaries when cancelled"
```

---

## Task 5: taskProcessor 按工程重构（核心）

**Files:**

- Modify: `main/helpers/taskProcessor.ts`（整文件重写）

- [ ] **Step 5.1: 重写 `main/helpers/taskProcessor.ts`**

保留文件头部的 `TASK_EVENT_CHANNELS`、`wrapTaskEvent`、`createExtendedProvider`、`checkMlmodel` 处理器与 `notifyAllDone`（重命名为 `notifyProjectDone`，函数体不变）。其余部分按下文实现（给出完整文件）：

```ts
import fse from 'fs-extra';
import { ipcMain, BrowserWindow, Notification } from 'electron';
import { processFile } from './fileProcessor';
import { checkOpenAiWhisper, getPath } from './whisper';
import { logMessage, store } from './storeManager';
import path from 'path';
import { isAppleSilicon } from './utils';
import { IFiles } from '../../types';
import { ExtendedProvider, CustomParameterConfig } from '../../types/provider';
import { configurationManager } from '../service/configurationManager';
import { applyTaskEventToProjects } from './taskManager';
import { runWithTaskContext } from './taskContext';
import { killFfmpegForFiles } from './audioProcessor';

const TASK_EVENT_CHANNELS = new Set([
  'taskStatusChange',
  'taskProgressChange',
  'taskErrorChange',
  'taskFileChange',
]);

/**
 * 包装 IPC event：任务事件除发往渲染层外，同步镜像进任务工程存储。
 * 这样用户中途离开任务页（无渲染层监听）时，工程状态也不会停留在 loading。
 */
function wrapTaskEvent(event: any) {
  const sender = event.sender;
  return {
    ...event,
    sender: {
      send: (channel: string, ...args: any[]) => {
        if (TASK_EVENT_CHANNELS.has(channel)) {
          applyTaskEventToProjects(channel, ...args);
        }
        try {
          sender.send(channel, ...args);
        } catch (error) {
          // 窗口销毁等场景下发送失败，但镜像已落库
          console.error('send task event failed', error);
        }
      },
    },
  };
}

interface QueueItem {
  file: IFiles;
  formData: any;
  projectId: string;
}

interface ProjectRuntime {
  /** 正在执行的文件数 */
  active: number;
  /** 正在执行的文件 uuid（取消时定位 ffmpeg 进程） */
  activeFiles: Set<string>;
  paused: boolean;
  cancelled: boolean;
  /** 取消信号：翻译批次边界与阶段边界检查 */
  controller: AbortController;
}

const DEFAULT_PROJECT_ID = 'default';

let processingQueue: QueueItem[] = [];
const projectRuntimes = new Map<string, ProjectRuntime>();
let isProcessing = false;
let maxConcurrentTasks = 3;
let hasOpenAiWhisper = false;
let activeTasksCount = 0;
/** 最近一次 handleTask 的 event：resume 触发派发时复用 */
let dispatchEvent: any = null;

function ensureRuntime(projectId: string): ProjectRuntime {
  let runtime = projectRuntimes.get(projectId);
  if (!runtime) {
    runtime = {
      active: 0,
      activeFiles: new Set(),
      paused: false,
      cancelled: false,
      controller: new AbortController(),
    };
    projectRuntimes.set(projectId, runtime);
  }
  return runtime;
}

function queuedCount(projectId: string): number {
  return processingQueue.filter((item) => item.projectId === projectId).length;
}

function sendTaskComplete(
  event: any,
  projectId: string,
  status: 'completed' | 'cancelled',
) {
  try {
    event?.sender?.send('taskComplete', { projectId, status });
  } catch (error) {
    console.error('send taskComplete failed', error);
  }
}

/** 工程内已无排队与执行中文件时收尾：发完成事件并清理运行时 */
function finalizeProjectIfDrained(event: any, projectId: string) {
  const runtime = projectRuntimes.get(projectId);
  if (!runtime) return;
  if (runtime.active > 0 || queuedCount(projectId) > 0) return;
  const status = runtime.cancelled ? 'cancelled' : 'completed';
  projectRuntimes.delete(projectId);
  sendTaskComplete(event, projectId, status);
  if (status === 'completed') notifyProjectDone(event);
}

/**
 * Load custom parameters for a provider and create an ExtendedProvider
 */
async function createExtendedProvider(
  baseProvider: any,
): Promise<ExtendedProvider> {
  try {
    // Get custom parameters from configuration manager
    const providerCustomParams: CustomParameterConfig | null =
      await configurationManager.getConfiguration(baseProvider.id);

    // Create extended provider with custom parameters
    const extendedProvider: ExtendedProvider = {
      ...baseProvider,
      customParameters: providerCustomParams,
    };

    if (providerCustomParams) {
      logMessage(
        `Custom parameters loaded for provider: ${baseProvider.id}`,
        'info',
      );
      logMessage(
        `Header parameters: ${Object.keys(providerCustomParams.headerParameters || {}).length}`,
        'info',
      );
      logMessage(
        `Body parameters: ${Object.keys(providerCustomParams.bodyParameters || {}).length}`,
        'info',
      );
    } else {
      logMessage(
        `No custom parameters found for provider: ${baseProvider.id}`,
        'info',
      );
    }

    return extendedProvider;
  } catch (error) {
    logMessage(
      `Error loading custom parameters for provider ${baseProvider.id}: ${error}`,
      'error',
    );
    // Return base provider if custom parameter loading fails
    return {
      ...baseProvider,
      customParameters: null,
    };
  }
}

export function setupTaskProcessor(mainWindow: BrowserWindow) {
  ipcMain.on(
    'handleTask',
    async (
      event,
      {
        files,
        formData,
        projectId,
      }: { files: IFiles[]; formData: any; projectId?: string },
    ) => {
      const pid = projectId || DEFAULT_PROJECT_ID;
      dispatchEvent = event;
      await runWithTaskContext({ projectId: pid }, async () => {
        logMessage(`handleTask start`, 'info');
        logMessage(`formData: \n ${JSON.stringify(formData, null, 2)}`, 'info');
      });
      const runtime = ensureRuntime(pid);
      // 重新开始：清除上一轮的暂停/取消残留
      runtime.paused = false;
      runtime.cancelled = false;
      if (runtime.controller.signal.aborted) {
        runtime.controller = new AbortController();
      }
      processingQueue.push(
        ...files.map((file) => ({ file, formData, projectId: pid })),
      );
      if (!isProcessing) {
        isProcessing = true;
        hasOpenAiWhisper = await checkOpenAiWhisper();
        maxConcurrentTasks = formData.maxConcurrentTasks || 3;
        processNextTasks(event);
      }
    },
  );

  ipcMain.on('pauseTask', (event, projectId?: string) => {
    if (projectId) {
      ensureRuntime(projectId).paused = true;
      return;
    }
    projectRuntimes.forEach((runtime) => {
      runtime.paused = true;
    });
  });

  ipcMain.on('resumeTask', (event, projectId?: string) => {
    if (projectId) {
      ensureRuntime(projectId).paused = false;
    } else {
      projectRuntimes.forEach((runtime) => {
        runtime.paused = false;
      });
    }
    if (processingQueue.length > 0) {
      isProcessing = true;
      processNextTasks(dispatchEvent || event);
    }
  });

  ipcMain.on('cancelTask', (event, projectId?: string) => {
    const ids = projectId
      ? [projectId]
      : [
          ...new Set([
            ...projectRuntimes.keys(),
            ...processingQueue.map((item) => item.projectId),
          ]),
        ];
    for (const id of ids) {
      processingQueue = processingQueue.filter((item) => item.projectId !== id);
      const runtime = projectRuntimes.get(id);
      if (runtime && runtime.active > 0) {
        runtime.cancelled = true;
        runtime.paused = false;
        runtime.controller.abort();
        // kill 该工程在跑的 ffmpeg 提取；转写无法中断，完成后在阶段边界停止
        killFfmpegForFiles([...runtime.activeFiles]);
        logMessage(
          `cancel project ${id}: ${runtime.active} running file(s) will stop at stage boundary`,
          'warning',
        );
      } else {
        projectRuntimes.delete(id);
        sendTaskComplete(event, id, 'cancelled');
      }
    }
  });

  // 获取指定工程的任务状态（无 projectId 时回退全局语义）
  ipcMain.handle('getTaskStatus', (event, projectId?: string) => {
    if (!projectId) {
      return activeTasksCount > 0 || processingQueue.length > 0
        ? 'running'
        : 'idle';
    }
    const runtime = projectRuntimes.get(projectId);
    const queued = queuedCount(projectId);
    if (!runtime) return queued > 0 ? 'running' : 'idle';
    if (runtime.cancelled) return runtime.active > 0 ? 'cancelling' : 'idle';
    if (runtime.paused) return 'paused';
    if (runtime.active > 0 || queued > 0) return 'running';
    return 'idle';
  });

  ipcMain.handle('checkMlmodel', async (event, modelName) => {
    // 如果不是苹果芯片，不需要该文件，直接返回true
    if (!isAppleSilicon()) {
      return true;
    }
    // 判断模型目录下是否存在 `ggml-${modelName}-encoder.mlmodelc` 文件或者目录
    const modelsPath = getPath('modelsPath');
    const modelPath = path.join(
      modelsPath,
      `ggml-${modelName}-encoder.mlmodelc`,
    );
    const exists = await fse.pathExists(modelPath);
    return exists;
  });
}

/** 工程全部完成且应用不在前台时发系统通知 */
function notifyProjectDone(event) {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isFocused()) return;
    if (!Notification.isSupported()) return;
    const lang = store.get('settings')?.language || 'zh';
    const notification = new Notification({
      title: lang === 'zh' ? '任务全部完成' : 'All tasks completed',
      body:
        lang === 'zh'
          ? '字幕任务已处理完毕，点击查看结果'
          : 'Your subtitle tasks are done — click to view results',
    });
    notification.on('click', () => {
      win?.show();
      win?.focus();
    });
    notification.show();
  } catch (error) {
    logMessage(`notifyProjectDone error: ${error}`, 'warning');
  }
}

/** 取出最多 limit 个可派发项（跳过暂停/已取消工程），其余留在队列 */
function takeEligibleItems(limit: number): QueueItem[] {
  const taken: QueueItem[] = [];
  const rest: QueueItem[] = [];
  for (const item of processingQueue) {
    const runtime = projectRuntimes.get(item.projectId);
    if (taken.length < limit && !runtime?.paused && !runtime?.cancelled) {
      taken.push(item);
    } else {
      rest.push(item);
    }
  }
  processingQueue = rest;
  return taken;
}

async function processNextTasks(event) {
  // 队列与执行均清空：全局收工
  if (processingQueue.length === 0 && activeTasksCount === 0) {
    isProcessing = false;
    return;
  }

  // 计算可以启动的新任务数量
  const availableSlots = maxConcurrentTasks - activeTasksCount;

  if (availableSlots > 0) {
    const tasksToProcess = takeEligibleItems(availableSlots);
    if (tasksToProcess.length > 0) {
      const translationProviders = store.get('translationProviders');

      tasksToProcess.forEach(async (task) => {
        const runtime = ensureRuntime(task.projectId);
        const fileUuid = task.file?.uuid;
        activeTasksCount++;
        runtime.active++;
        if (fileUuid) runtime.activeFiles.add(fileUuid);
        try {
          const baseProvider = translationProviders.find(
            (p) => p.id === task.formData.translateProvider,
          );

          // Create extended provider with custom parameters
          const extendedProvider = await createExtendedProvider(baseProvider);

          await runWithTaskContext(
            {
              projectId: task.projectId,
              fileUuid,
              signal: runtime.controller.signal,
            },
            () =>
              processFile(
                wrapTaskEvent(event),
                task.file as IFiles,
                task.formData,
                hasOpenAiWhisper,
                extendedProvider,
              ),
          );
        } catch (error) {
          event.sender.send('message', error);
        } finally {
          activeTasksCount--;
          runtime.active--;
          if (fileUuid) runtime.activeFiles.delete(fileUuid);
          finalizeProjectIfDrained(event, task.projectId);
          // 处理完一个任务后，检查是否可以启动新任务
          processNextTasks(event);
        }
      });
    }
  }

  // 有任务在跑（100ms）或队列里还躺着暂停项（500ms）：保持轮询，
  // 这样 handleTask/resumeTask 之后的新增项总能被派发
  if (activeTasksCount > 0) {
    setTimeout(() => processNextTasks(event), 100);
  } else if (processingQueue.length > 0) {
    setTimeout(() => processNextTasks(event), 500);
  }
}
```

- [ ] **Step 5.2: 类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: 0 错误

- [ ] **Step 5.3: Commit**

```bash
git add main/helpers/taskProcessor.ts
git commit -m "feat(tasks): per-project task queue with real cancel/pause semantics"
```

---

## Task 6: TaskControls 重写（误判修复 + 按工程控制 + 取消中态）

**Files:**

- Modify: `renderer/components/TaskControls.tsx`（整文件重写）
- Modify: `renderer/public/locales/zh/home.json`、`renderer/public/locales/en/home.json`（新增 4 个 key）

- [ ] **Step 6.1: i18n key（zh/home.json）**

在 `"cancelTask": "取消任务",` 一行之后插入：

```json
  "cancelling": "取消中…",
  "cancellingHint": "正在停止：转写中的文件完成当前转写后停止",
  "pausedHint": "已暂停：不再开始新文件，进行中的文件会继续完成",
  "pauseTip": "暂停后不再开始新文件，进行中的文件会继续完成",
```

- [ ] **Step 6.2: i18n key（en/home.json）**

在 `"cancelTask": "Cancel Task",` 之后插入：

```json
  "cancelling": "Cancelling…",
  "cancellingHint": "Stopping — files mid-transcription finish the current pass, then stop",
  "pausedHint": "Paused: no new files will start; in-progress files keep running",
  "pauseTip": "Pause stops new files from starting; in-progress files keep running",
```

- [ ] **Step 6.3: 重写 `renderer/components/TaskControls.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import type { TaskTypeDef } from 'lib/taskTypes';
import { getFileStages, isFileDone } from './tasks/stageUtils';

interface TaskControlsProps {
  files: any[];
  formData: any;
  typeDef: TaskTypeDef;
  projectId: string | null;
  className?: string;
  /** 可选：状态变化时上抛（任务页用于联动重试按钮/完成横幅） */
  onStatusChange?: (status: string) => void;
}

type TaskCompletePayload = { projectId?: string; status?: string } | string;

const TaskControls = ({
  files,
  formData,
  typeDef,
  projectId,
  className,
  onStatusChange,
}: TaskControlsProps) => {
  const [taskStatus, setTaskStatusState] = useState('idle');
  const { t } = useTranslation(['home', 'common']);

  const setTaskStatus = (status: string) => {
    setTaskStatusState(status);
    onStatusChange?.(status);
  };

  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    // 获取当前工程的任务状态
    const getCurrentTaskStatus = async () => {
      const status = await window?.ipc?.invoke('getTaskStatus', projectId);
      if (!disposed && status) setTaskStatus(status);
    };
    getCurrentTaskStatus();

    // 监听本工程的任务完成事件
    const cleanup = window?.ipc?.on(
      'taskComplete',
      (payload: TaskCompletePayload) => {
        const status = typeof payload === 'string' ? payload : payload?.status;
        const pid =
          typeof payload === 'string' ? undefined : payload?.projectId;
        if (pid && pid !== projectId) return;
        if (status) setTaskStatus(status);
      },
    );

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [projectId]);

  const handleTask = async () => {
    if (!files?.length) {
      toast(t('common:notification'), {
        description: t('home:noTask'),
      });
      return;
    }
    // 只派发未完成的文件（error 不算完成，可重跑；已完成文件不重做）
    const pendingFiles = files.filter(
      (file) => !isFileDone(file, getFileStages(file, typeDef, formData)),
    );
    if (!pendingFiles.length) {
      toast(t('common:notification'), {
        description: t('home:allFilesProcessed'),
      });
      return;
    }
    setTaskStatus('running');
    window?.ipc?.send('handleTask', {
      files: pendingFiles,
      formData,
      projectId,
    });
  };
  const handlePause = () => {
    window?.ipc?.send('pauseTask', projectId);
    setTaskStatus('paused');
  };

  const handleResume = () => {
    window?.ipc?.send('resumeTask', projectId);
    setTaskStatus('running');
  };

  const handleCancel = () => {
    window?.ipc?.send('cancelTask', projectId);
    setTaskStatus('cancelling');
  };

  const showStart =
    taskStatus === 'idle' ||
    taskStatus === 'completed' ||
    taskStatus === 'cancelled';

  return (
    <div className={cn('flex items-center gap-2 ml-auto', className)}>
      {taskStatus === 'paused' && (
        <span className="text-xs text-muted-foreground">
          {t('home:pausedHint')}
        </span>
      )}
      {taskStatus === 'cancelling' && (
        <span className="text-xs text-muted-foreground">
          {t('home:cancellingHint')}
        </span>
      )}
      {showStart && (
        <Button onClick={handleTask} disabled={!files.length}>
          {taskStatus === 'cancelled'
            ? t('home:restartTask')
            : t('home:startTask')}
        </Button>
      )}
      {taskStatus === 'running' && (
        <>
          <Button onClick={handlePause} title={t('home:pauseTip')}>
            {t('home:pauseTask')}
          </Button>
          <Button onClick={handleCancel}>{t('home:cancelTask')}</Button>
        </>
      )}
      {taskStatus === 'paused' && (
        <>
          <Button onClick={handleResume}>{t('home:resumeTask')}</Button>
          <Button onClick={handleCancel}>{t('home:cancelTask')}</Button>
        </>
      )}
      {taskStatus === 'cancelling' && (
        <Button disabled>{t('home:cancelling')}</Button>
      )}
    </div>
  );
};

export default TaskControls;
```

- [ ] **Step 6.4: 类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: renderer 检查会报 `tasks/[type].tsx` 缺 `typeDef`/`projectId` props 的错误——这是预期的中间态，Task 7 修复。若只剩这一类错误即可继续。

- [ ] **Step 6.5: Commit（与 Task 7 合并提交亦可，若想保持每步可编译则延后到 Task 7 一起提交）**

推荐：不在此提交，Task 7 完成后一起提交，保证提交点可编译。

---

## Task 7: 任务页接线（projectId 贯穿渲染层）

**Files:**

- Modify: `renderer/pages/[locale]/tasks/[type].tsx`
- Modify: `renderer/components/tasks/LogPanel.tsx`
- Modify: `renderer/public/locales/zh/tasks.json`、`renderer/public/locales/en/tasks.json`

- [ ] **Step 7.1: `tasks/[type].tsx` — 状态获取与 taskComplete 按工程过滤**

把首个 `useEffect`（加载 providers/settings/status 的那个）中的：

```tsx
      const status = await window?.ipc?.invoke('getTaskStatus');
      if (status) setTaskStatus(status);
    };
    load();

    const unsubComplete = window?.ipc?.on('taskComplete', (status: string) => {
      setTaskStatus(status);
    });
    return () => {
      unsubComplete?.();
    };
  }, []);
```

改为（状态相关逻辑移走，该 effect 只剩 providers/settings）：

```tsx
    };
    load();
  }, []);

  // 任务状态按工程获取与监听
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    (async () => {
      const status = await window?.ipc?.invoke('getTaskStatus', projectId);
      if (!disposed && status) setTaskStatus(status);
    })();
    const unsubComplete = window?.ipc?.on(
      'taskComplete',
      (payload: { projectId?: string; status?: string } | string) => {
        const status = typeof payload === 'string' ? payload : payload?.status;
        const pid =
          typeof payload === 'string' ? undefined : payload?.projectId;
        if (pid && pid !== projectId) return;
        if (status) setTaskStatus(status);
      },
    );
    return () => {
      disposed = true;
      unsubComplete?.();
    };
  }, [projectId]);
```

注意：原 `load()` 内的 `const status = ...` 与 `if (status) setTaskStatus(status);` 两行删除。

- [ ] **Step 7.2: `tasks/[type].tsx` — 重试入口带 projectId**

把：

```tsx
window?.ipc?.send('handleTask', { files: [file], formData });
```

改为：

```tsx
window?.ipc?.send('handleTask', { files: [file], formData, projectId });
```

（`handleRetry` 的 deps 数组 `[formData]` 改为 `[formData, projectId]`。）

把：

```tsx
window?.ipc?.send('handleTask', { files: failedFiles, formData });
```

改为：

```tsx
window?.ipc?.send('handleTask', { files: failedFiles, formData, projectId });
```

（`handleRetryFailed` 的 deps 数组同样加 `projectId`。）

- [ ] **Step 7.3: `tasks/[type].tsx` — TaskControls 与 LogPanel 传参**

把：

```tsx
<TaskControls
  formData={formData}
  files={files}
  onStatusChange={handleStatusChange}
/>
```

改为：

```tsx
<TaskControls
  formData={formData}
  files={files}
  typeDef={typeDef}
  projectId={projectId}
  onStatusChange={handleStatusChange}
/>
```

把：

```tsx
<LogPanel className="flex-shrink-0" />
```

改为：

```tsx
<LogPanel className="flex-shrink-0" projectId={projectId} />
```

- [ ] **Step 7.4: `LogPanel.tsx` — 按工程过滤**

把组件签名与订阅 effect：

```tsx
const LogPanel: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('tasks');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window?.ipc?.invoke('getLogs').then((initial: LogEntry[]) => {
      setLogs(initial || []);
    });
    const unsubscribe = window?.ipc?.on('newLog', (log: LogEntry) => {
      setLogs((prev) => [...prev, log]);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);
```

改为：

```tsx
const LogPanel: React.FC<{
  className?: string;
  /** 提供时只显示该工程的日志（系统/Updater 日志不再混入） */
  projectId?: string | null;
}> = ({ className, projectId }) => {
  const { t } = useTranslation('tasks');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLogs([]);
    window?.ipc
      ?.invoke('getLogs', projectId || undefined)
      .then((initial: LogEntry[]) => {
        setLogs(initial || []);
      });
    const unsubscribe = window?.ipc?.on(
      'newLog',
      (log: LogEntry & { projectId?: string }) => {
        if (projectId && log?.projectId !== projectId) return;
        setLogs((prev) => [...prev, log]);
      },
    );
    return () => {
      unsubscribe?.();
    };
  }, [projectId]);
```

- [ ] **Step 7.5: 日志面板标题文案（明确「本任务」）**

`renderer/public/locales/zh/tasks.json` 中 `"logs"` 对象：

```json
  "logs": {
    "title": "运行日志（本任务）",
    "clear": "清空",
    "empty": "暂无日志"
  },
```

`renderer/public/locales/en/tasks.json` 中对应（现值为 `{"title": "Activity log", "clear": "Clear", "empty": "No logs yet"}`，只改 title）：

```json
  "logs": {
    "title": "Activity log (this task)",
    "clear": "Clear",
    "empty": "No logs yet"
  },
```

- [ ] **Step 7.6: 类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: 0 错误（Task 6 的中间态错误此时应消失）

- [ ] **Step 7.7: Commit（含 Task 6 改动）**

```bash
git add renderer/components/TaskControls.tsx renderer/pages/\[locale\]/tasks/\[type\].tsx renderer/components/tasks/LogPanel.tsx renderer/public/locales/zh/home.json renderer/public/locales/en/home.json renderer/public/locales/zh/tasks.json renderer/public/locales/en/tasks.json
git commit -m "feat(tasks): project-scoped controls, accurate done-check and per-project log panel"
```

---

## Task 8: 取消中行态与完成横幅守卫

**Files:**

- Modify: `renderer/components/tasks/CompletionBanner.tsx`
- Modify: `renderer/components/tasks/TaskRowList.tsx`
- Modify: `renderer/public/locales/zh/tasks.json`、`renderer/public/locales/en/tasks.json`（row.cancelling）

- [ ] **Step 8.1: `CompletionBanner.tsx` — 取消态不弹横幅**

把：

```tsx
if (dismissed || !files.length || taskStatus === 'running') return null;
```

改为：

```tsx
if (
  dismissed ||
  !files.length ||
  taskStatus === 'running' ||
  taskStatus === 'cancelling' ||
  taskStatus === 'cancelled'
)
  return null;
```

- [ ] **Step 8.2: `TaskRowList.tsx` — 取消中提示行 + queueBusy 含取消中**

把：

```tsx
const queueBusy = taskStatus === 'running' || taskStatus === 'paused';
```

改为：

```tsx
const queueBusy =
  taskStatus === 'running' ||
  taskStatus === 'paused' ||
  taskStatus === 'cancelling';
```

在 `files.map` 回调内，`const started = ...` 之后追加：

```tsx
const cancelling =
  taskStatus === 'cancelling' &&
  stages.some((s) => getStageStatus(file, s.key) === 'loading');
```

在 `{failed && errorMsg && (...)}` 块之前插入：

```tsx
{
  cancelling && (
    <p className="mt-1.5 pl-5 text-xs text-amber-600 dark:text-amber-500">
      {t('row.cancelling')}
    </p>
  );
}
```

- [ ] **Step 8.3: i18n（tasks.json 的 row 对象）**

zh `"row"` 对象内追加：

```json
    "cancelling": "取消中…完成当前转写后停止",
```

en `"row"` 对象内追加：

```json
    "cancelling": "Cancelling… stops after the current transcription finishes",
```

- [ ] **Step 8.4: 类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: 0 错误

- [ ] **Step 8.5: Commit**

```bash
git add renderer/components/tasks/CompletionBanner.tsx renderer/components/tasks/TaskRowList.tsx renderer/public/locales/zh/tasks.json renderer/public/locales/en/tasks.json
git commit -m "feat(tasks): cancelling row hint and suppress completion banner on cancel"
```

---

## Task 9: 冒烟自检与验收交接

- [ ] **Step 9.1: 全量类型检查**

Run: `npx tsc --noEmit && npx tsc --noEmit -p renderer/tsconfig.json`
Expected: 0 错误

- [ ] **Step 9.2: 启动应用冒烟**

Run: `npm run dev`（后台启动，等待 Electron 窗口出现）
检查：任务页可正常打开、导入文件、开始任务、日志面板有输出且不含 Updater 日志。

- [ ] **Step 9.3: 把验收清单交给用户人工验证**

1. 全部失败的列表点「开始任务」能重跑，不再提示「已处理」；且不重做已完成文件；
2. 运行中点「取消」：队列清空；提取/翻译阶段数秒内真停；转写中文件行显示「取消中…完成当前转写后停止」，转写完成后不再翻译；
3. A 工程运行时打开 B 工程：B 页面是「开始任务」而非 A 的暂停/取消；B 日志面板无 A 日志、无 Updater 日志；B 发起取消不影响 A；
4. 暂停后不再派发新文件，恢复继续；暂停时控件旁有「已暂停：不再开始新文件…」说明；
5. 取消后不弹「全部完成」横幅。

---

## 已知边界与决策提醒（执行时勿走偏）

- whisper 原生转写**不可中断**是本批次的接受约束（2.18 跟进），不要尝试改 addon 或迁子进程；
- 被取消文件的未执行阶段保持 `pending`（空字符串复位），**不要**标 `error`；
- 取消导致的 ffmpeg kill / 翻译中止**不得**触发错误 toast 或 `taskErrorChange`；
- `getTaskStatus` 无参调用保留全局语义（兼容兜底），不要删除；
- 不动：`taskManager.ts`、`applyTaskEventToProjects` 镜像、TASK_INTERRUPTED 恢复链路、whisper.ts、preload.ts。
