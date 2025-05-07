import fse from 'fs-extra';
import { ipcMain, BrowserWindow, type IpcMainEvent } from 'electron';
import { processFile } from './fileProcessor';
import { checkOpenAiWhisper, getPath } from './whisper';
import { logMessage, store } from './storeManager';
import path from 'path';
import { isAppleSilicon } from './utils';
import type { ITaskFile } from '../../types';

let processingQueue: ITaskFile[] = [];
let isProcessing = false;
let isPaused = false;
let shouldCancel = false;
let maxConcurrentTasks = 3;
let hasOpenAiWhisper = false;
let activeTasksCount = 0;

export function setupTaskProcessor(mainWindow: BrowserWindow) {
  ipcMain.on(
    'handleTask',
    async (
      event,
      { files, formData }: { files: ITaskFile[]; formData: any },
    ) => {
      logMessage(`handleTask start`, 'info');
      logMessage(`formData: \n ${JSON.stringify(formData, null, 2)}`, 'info');
      processingQueue.push(...files);
      if (!isProcessing) {
        isProcessing = true;
        isPaused = false;
        shouldCancel = false;
        hasOpenAiWhisper = await checkOpenAiWhisper();
        maxConcurrentTasks = formData.maxConcurrentTasks || 3;
        processNextTasks(event);
      }
    },
  );

  ipcMain.on('pauseTask', () => {
    isPaused = true;
  });

  ipcMain.on('resumeTask', () => {
    isPaused = false;
  });

  ipcMain.on('cancelTask', () => {
    shouldCancel = true;
    isPaused = false;
    processingQueue = [];
  });

  // 添加获取当前任务状态的 IPC 处理程序
  ipcMain.handle('getTaskStatus', () => {
    if (shouldCancel) return 'cancelled';
    if (isPaused) return 'paused';
    if (isProcessing) return 'running';
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

async function processNextTasks(event: IpcMainEvent) {
  if (shouldCancel) {
    isProcessing = false;
    event.sender.send('taskComplete', 'cancelled');
    return;
  }

  if (isPaused) {
    setTimeout(() => processNextTasks(event), 1000);
    return;
  }

  // 当队列为空且没有活动任务时，才完成处理
  if (processingQueue.length === 0 && activeTasksCount === 0) {
    isProcessing = false;
    event.sender.send('taskComplete', 'completed');
    return;
  }

  // 计算可以启动的新任务数量
  const availableSlots = maxConcurrentTasks - activeTasksCount;

  // 如果有可用槽位且队列中有任务，则启动新任务
  if (availableSlots > 0 && processingQueue.length > 0) {
    const tasksToProcess = processingQueue.splice(0, availableSlots);
    const translationProviders = store.get('translationProviders');

    tasksToProcess.forEach(async (task) => {
      activeTasksCount++;
      try {
        const provider = translationProviders.find(
          (p) => p.id === task.formData?.translateProvider,
        );
        await processFile(event, task, hasOpenAiWhisper, provider);
      } catch (error) {
        console.error(error.stack || error);
        event.sender.send('message', error);
      } finally {
        activeTasksCount--;
        // 处理完一个任务后，检查是否可以启动新任务
        processNextTasks(event);
      }
    });
  }

  // 如果还有正在执行的任务，等待一段时间后再检查
  if (activeTasksCount > 0) {
    setTimeout(() => processNextTasks(event), 100);
  }
}
