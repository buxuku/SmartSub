import fse from 'fs-extra';
import { ipcMain, BrowserWindow } from 'electron';
import { processFile } from './fileProcessor';
import { checkOpenAiWhisper, getPath } from './whisper';
import { logMessage, store } from './storeManager';
import path from 'path';
import { isAppleSilicon } from './utils';
import { IFiles } from '../../types';
import { ExtendedProvider, CustomParameterConfig } from '../../types/provider';
import { configurationManager } from '../service/configurationManager';

let processingQueue = [];
let isProcessing = false;
let isPaused = false;
let shouldCancel = false;
let maxConcurrentTasks = 3;
let hasOpenAiWhisper = false;
let activeTasksCount = 0;

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
    async (event, { files, formData }: { files: IFiles[]; formData: any }) => {
      console.log('handleTask start', files);
      logMessage(`handleTask start`, 'info');
      logMessage(`formData: \n ${JSON.stringify(formData, null, 2)}`, 'info');
      processingQueue.push(...files.map((file) => ({ file, formData })));
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

async function processNextTasks(event) {
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
        const baseProvider = translationProviders.find(
          (p) => p.id === task.formData.translateProvider,
        );

        // Create extended provider with custom parameters
        const extendedProvider = await createExtendedProvider(baseProvider);

        await processFile(
          event,
          task.file as IFiles,
          task.formData,
          hasOpenAiWhisper,
          extendedProvider,
        );
      } catch (error) {
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
