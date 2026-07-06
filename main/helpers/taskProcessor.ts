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
import {
  listEngineAdapters,
  getEngineAdapterForTask,
} from './engines/registry';
import { getPythonRuntimeManager } from './pythonRuntime';
import {
  acquireTaskPowerSaveBlocker,
  releaseTaskPowerSaveBlocker,
} from './powerSaveManager';

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
  /** 本轮入列的文件总数（Dock/任务栏进度分母） */
  total: number;
  /** 已结束（成功/失败/取消）的文件数（进度分子） */
  completed: number;
}

const DEFAULT_PROJECT_ID = 'default';
const TRANSCRIPTION_POWER_SAVE_REASON = 'transcription';

let processingQueue: QueueItem[] = [];
const projectRuntimes = new Map<string, ProjectRuntime>();
let isProcessing = false;
let maxConcurrentTasks = 3;
let hasOpenAiWhisper = false;
let activeTasksCount = 0;

/** 最近一次 handleTask 的 event：resume 触发派发时复用 */
let dispatchEvent: any = null;
/** Dock/任务栏进度条目标窗口 */
let progressWindow: BrowserWindow | null = null;

function hasRunnableQueuedTasks(): boolean {
  return processingQueue.some((item) => {
    const runtime = projectRuntimes.get(item.projectId);
    return !runtime?.paused && !runtime?.cancelled;
  });
}

function syncTranscriptionPowerSaveBlocker() {
  if (activeTasksCount > 0 || hasRunnableQueuedTasks()) {
    acquireTaskPowerSaveBlocker(TRANSCRIPTION_POWER_SAVE_REASON);
  } else {
    releaseTaskPowerSaveBlocker(TRANSCRIPTION_POWER_SAVE_REASON);
  }
}

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

function ensureRuntime(projectId: string): ProjectRuntime {
  let runtime = projectRuntimes.get(projectId);
  if (!runtime) {
    runtime = {
      active: 0,
      activeFiles: new Set(),
      paused: false,
      cancelled: false,
      controller: new AbortController(),
      total: 0,
      completed: 0,
    };
    projectRuntimes.set(projectId, runtime);
  }
  return runtime;
}

/** 按文件粒度聚合全部工程，更新 macOS Dock / Windows 任务栏进度条 */
function updateTaskbarProgress() {
  if (!progressWindow || progressWindow.isDestroyed()) return;
  try {
    let total = 0;
    let completed = 0;
    projectRuntimes.forEach((runtime) => {
      total += runtime.total;
      completed += runtime.completed;
    });
    if (total === 0) {
      progressWindow.setProgressBar(-1);
    } else {
      progressWindow.setProgressBar(Math.min(completed / total, 1));
    }
  } catch (error) {
    logMessage(`updateTaskbarProgress error: ${error}`, 'warning');
  }
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
  updateTaskbarProgress();
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
  progressWindow = mainWindow;
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
      runtime.total += files.length;
      updateTaskbarProgress();
      syncTranscriptionPowerSaveBlocker();
      // 每批都刷新并发上限：流水线跑着时追加新批次，用户最新设置也能生效
      maxConcurrentTasks = formData.maxConcurrentTasks || 3;
      if (!isProcessing) {
        isProcessing = true;
        hasOpenAiWhisper = await checkOpenAiWhisper();
        // 预热 sidecar：把冷启动成本移出首个文件关键路径（faster-whisper 等需运行时引擎）。
        // ensureStarted 成功后再 prewarm（按引擎预加载模型），与首个文件的音频抽取并行，
        // 避免 FunASR 等首个 transcribe 因首次加载原生库/ONNX 过慢而长时间卡在 0%。
        try {
          // 按本批任务携带的引擎预热（缺省回退全局/默认）。
          const batchAdapter = getEngineAdapterForTask(formData);
          if (batchAdapter.requiresRuntime && batchAdapter.pyEngineId) {
            // Python 运行时引擎（faster-whisper）：先拉起 sidecar 再预热。
            void getPythonRuntimeManager()
              .ensureStarted(batchAdapter.pyEngineId)
              .then(() => batchAdapter.prewarm?.(formData))
              .catch((e) =>
                logMessage(`engine warmup failed (non-fatal): ${e}`, 'warning'),
              );
          } else if (batchAdapter.prewarm) {
            // 无 Python 的引擎（funasr/sherpa）：worker 线程直接预加载模型。
            batchAdapter.prewarm(formData);
          }
        } catch (e) {
          logMessage(`engine warmup skipped: ${e}`, 'warning');
        }
        processNextTasks(event);
      }
    },
  );

  ipcMain.on('pauseTask', (event, projectId?: string) => {
    if (projectId) {
      ensureRuntime(projectId).paused = true;
      syncTranscriptionPowerSaveBlocker();
      return;
    }
    projectRuntimes.forEach((runtime) => {
      runtime.paused = true;
    });
    syncTranscriptionPowerSaveBlocker();
  });

  ipcMain.on('resumeTask', (event, projectId?: string) => {
    if (projectId) {
      ensureRuntime(projectId).paused = false;
    } else {
      projectRuntimes.forEach((runtime) => {
        runtime.paused = false;
      });
    }
    syncTranscriptionPowerSaveBlocker();
    if (processingQueue.length > 0) {
      isProcessing = true;
      processNextTasks(dispatchEvent || event);
    }
  });

  ipcMain.on('cancelTask', (event, projectId?: string) => {
    const ids = projectId
      ? [projectId]
      : Array.from(
          new Set([
            ...Array.from(projectRuntimes.keys()),
            ...processingQueue.map((item) => item.projectId),
          ]),
        );
    for (const id of ids) {
      const beforeCount = processingQueue.length;
      processingQueue = processingQueue.filter((item) => item.projectId !== id);
      const removedCount = beforeCount - processingQueue.length;
      const runtime = projectRuntimes.get(id);
      if (runtime) {
        runtime.total = Math.max(runtime.total - removedCount, 0);
      }
      if (runtime && runtime.active > 0) {
        runtime.cancelled = true;
        runtime.paused = false;
        // 取消经各任务的 AbortSignal 精确中断：引擎适配器都监听了 signal
        // （builtin/localCli/cloud 原生中断；faster-whisper/sherpa 系按转写 id 通知
        // 各自 runtime 取消），不再对全部适配器广播 cancelActive——任务级并发下
        // 广播会误伤其它工程正在执行的转写。
        runtime.controller.abort();
        // kill ffmpeg 提取；whisper 转写经 AbortSignal 同步中断
        killFfmpegForFiles(Array.from(runtime.activeFiles));
        logMessage(
          `cancel project ${id}: aborting ${runtime.active} running file(s)`,
          'warning',
        );
      } else {
        projectRuntimes.delete(id);
        sendTaskComplete(event, id, 'cancelled');
      }
    }
    // 全局取消（未指定工程）时仍广播 cancelActive 作为兜底：
    // 此时所有工程都要停，不存在误伤面。
    if (!projectId) {
      for (const adapter of listEngineAdapters()) {
        try {
          adapter.cancelActive();
        } catch (err) {
          logMessage(`cancelActive(${adapter.id}) failed: ${err}`, 'warning');
        }
      }
    }
    updateTaskbarProgress();
    syncTranscriptionPowerSaveBlocker();
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
  syncTranscriptionPowerSaveBlocker();
  // 队列与执行均清空：全局收工
  if (processingQueue.length === 0 && activeTasksCount === 0) {
    isProcessing = false;
    return;
  }

  // 任务级并发统一遵循用户配置的 maxConcurrentTasks。
  // 受限引擎（faster-whisper / funasr / qwen / fireRedAsr 共享单 sidecar/worker）
  // 不再在此钳制整个队列：其「转写阶段」由 transcribeGate 按执行体组排队，
  // 排队期间同批其它文件的音频提取 / 翻译 / 云端转写照常并行（阶段流水线）。
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

          // 找不到服务商（'-1' 残留或已删除）时不加载扩展参数；
          // 是否报错由翻译阶段判定，转写等阶段照常执行
          const extendedProvider = baseProvider
            ? await createExtendedProvider(baseProvider)
            : undefined;

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
          runtime.completed++;
          if (fileUuid) runtime.activeFiles.delete(fileUuid);
          finalizeProjectIfDrained(event, task.projectId);
          syncTranscriptionPowerSaveBlocker();
          updateTaskbarProgress();
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
