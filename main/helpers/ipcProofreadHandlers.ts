/**
 * 字幕校对相关的 IPC 处理器
 */

import { ipcMain } from 'electron';
import {
  detectSubtitlesForVideo,
  matchSubtitlesByRules,
  scanDirectoryForSubtitles,
  smartScanDirectory,
  validateSubtitleFile,
} from './subtitleDetector';
import {
  getProofreadTasks,
  getProofreadTaskById,
  createProofreadTask,
  updateProofreadTask,
  deleteProofreadTask,
  clearProofreadTasks,
  updateProofreadItem,
  completeProofreadItem,
  addItemsToTask,
  removeItemFromTask,
  getTaskProgress,
  getProofreadHistories,
  clearProofreadHistories,
} from './proofreadStore';
import {
  detectLanguageFromFilename,
  getSupportedLanguages,
  detectLanguagePair,
} from './languageDetector';
import { logMessage, store } from './storeManager';
import { ProofreadItem } from '../../types/proofread';
import { TRANSLATOR_MAP } from '../translate/services/translationProvider';
import { Provider } from '../translate/types';

/**
 * 设置字幕校对相关的 IPC 处理器
 */
export function setupProofreadHandlers(): void {
  // ============ 字幕检测相关 ============

  // 检测视频对应的字幕文件（不再需要语言参数）
  ipcMain.handle(
    'detectSubtitles',
    async (_event, { videoPath }: { videoPath: string }) => {
      try {
        logMessage(`Detecting subtitles for video: ${videoPath}`, 'info');
        // 使用空字符串让检测器自动从文件名推断
        const result = await detectSubtitlesForVideo(videoPath, '', '');
        logMessage(
          `Found ${result.detectedSubtitles.length} subtitle files`,
          'info',
        );
        return { success: true, data: result };
      } catch (error) {
        logMessage(`Error detecting subtitles: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 根据规则匹配字幕文件（不再需要语言参数）
  ipcMain.handle(
    'matchSubtitleFiles',
    async (_event, { files }: { files: string[] }) => {
      try {
        logMessage(`Matching ${files.length} subtitle files`, 'info');
        const result = await matchSubtitlesByRules(files, '', '');
        logMessage(`Matched ${result.length} subtitle pairs`, 'info');
        return { success: true, data: result };
      } catch (error) {
        logMessage(`Error matching subtitles: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 扫描目录获取字幕文件
  ipcMain.handle(
    'scanDirectorySubtitles',
    async (_event, { directoryPath }: { directoryPath: string }) => {
      try {
        logMessage(
          `Scanning directory for subtitles: ${directoryPath}`,
          'info',
        );
        const files = await scanDirectoryForSubtitles(directoryPath);
        logMessage(`Found ${files.length} subtitle files in directory`, 'info');
        return { success: true, data: files };
      } catch (error) {
        logMessage(`Error scanning directory: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 智能扫描目录（同时获取视频和字幕）
  ipcMain.handle(
    'smartScanDirectory',
    async (_event, { directoryPath }: { directoryPath: string }) => {
      try {
        logMessage(`Smart scanning directory: ${directoryPath}`, 'info');
        const result = await smartScanDirectory(directoryPath);
        logMessage(
          `Found ${result.videos.length} videos and ${result.subtitles.length} subtitles`,
          'info',
        );
        return { success: true, data: result };
      } catch (error) {
        logMessage(`Error smart scanning directory: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 验证字幕文件
  ipcMain.handle(
    'validateSubtitleFile',
    async (_event, { filePath }: { filePath: string }) => {
      try {
        const isValid = await validateSubtitleFile(filePath);
        return { success: true, data: isValid };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  // ============ 语言检测相关 ============

  // 从文件名检测语言
  ipcMain.handle(
    'detectLanguage',
    async (_event, { filePath }: { filePath: string }) => {
      try {
        const result = detectLanguageFromFilename(filePath);
        return { success: true, data: result };
      } catch (error) {
        logMessage(`Error detecting language: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 从多个字幕文件检测语言对
  ipcMain.handle(
    'detectLanguagePair',
    async (_event, { files }: { files: string[] }) => {
      try {
        const result = detectLanguagePair(files);
        return { success: true, data: result };
      } catch (error) {
        logMessage(`Error detecting language pair: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 获取支持的语言列表
  ipcMain.handle('getSupportedLanguages', async () => {
    try {
      const languages = getSupportedLanguages();
      return { success: true, data: languages };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ============ 任务管理相关 ============

  // 获取所有校对任务
  ipcMain.handle('getProofreadTasks', async () => {
    try {
      const tasks = getProofreadTasks();
      return { success: true, data: tasks };
    } catch (error) {
      logMessage(`Error getting proofread tasks: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  // 根据 ID 获取单个任务
  ipcMain.handle(
    'getProofreadTaskById',
    async (_event, { id }: { id: string }) => {
      try {
        const task = getProofreadTaskById(id);
        return { success: true, data: task };
      } catch (error) {
        logMessage(`Error getting proofread task: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 创建新任务
  ipcMain.handle(
    'createProofreadTask',
    async (
      _event,
      {
        items,
        name,
      }: {
        items: Omit<
          ProofreadItem,
          'id' | 'status' | 'lastPosition' | 'totalCount' | 'modifiedCount'
        >[];
        name?: string;
      },
    ) => {
      try {
        logMessage(
          `Creating proofread task with ${items.length} items`,
          'info',
        );
        const task = createProofreadTask(items, name);
        return { success: true, data: task };
      } catch (error) {
        logMessage(`Error creating proofread task: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 更新任务
  ipcMain.handle(
    'updateProofreadTask',
    async (
      _event,
      {
        taskId,
        updates,
      }: {
        taskId: string;
        updates: any;
      },
    ) => {
      try {
        const task = updateProofreadTask(taskId, updates);
        return { success: true, data: task };
      } catch (error) {
        logMessage(`Error updating proofread task: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 删除任务
  ipcMain.handle(
    'deleteProofreadTask',
    async (_event, { taskId }: { taskId: string }) => {
      try {
        logMessage(`Deleting proofread task: ${taskId}`, 'info');
        const deleted = deleteProofreadTask(taskId);
        return { success: true, data: deleted };
      } catch (error) {
        logMessage(`Error deleting proofread task: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 清空所有任务
  ipcMain.handle('clearProofreadTasks', async () => {
    try {
      logMessage('Clearing all proofread tasks', 'info');
      clearProofreadTasks();
      return { success: true };
    } catch (error) {
      logMessage(`Error clearing proofread tasks: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  // ============ 项目管理相关 ============

  // 更新任务中的单个项目
  ipcMain.handle(
    'updateProofreadItem',
    async (
      _event,
      {
        taskId,
        itemId,
        updates,
      }: {
        taskId: string;
        itemId: string;
        updates: Partial<Omit<ProofreadItem, 'id'>>;
      },
    ) => {
      try {
        const item = updateProofreadItem(taskId, itemId, updates);
        return { success: true, data: item };
      } catch (error) {
        logMessage(`Error updating proofread item: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 完成当前项目并移动到下一个
  ipcMain.handle(
    'completeProofreadItem',
    async (
      _event,
      {
        taskId,
        itemId,
      }: {
        taskId: string;
        itemId: string;
      },
    ) => {
      try {
        logMessage(
          `Completing proofread item: ${itemId} in task ${taskId}`,
          'info',
        );
        const result = completeProofreadItem(taskId, itemId);
        return { success: true, data: result };
      } catch (error) {
        logMessage(`Error completing proofread item: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 向任务添加新项目
  ipcMain.handle(
    'addItemsToTask',
    async (
      _event,
      {
        taskId,
        items,
      }: {
        taskId: string;
        items: Omit<
          ProofreadItem,
          'id' | 'status' | 'lastPosition' | 'totalCount' | 'modifiedCount'
        >[];
      },
    ) => {
      try {
        logMessage(`Adding ${items.length} items to task ${taskId}`, 'info');
        const task = addItemsToTask(taskId, items);
        return { success: true, data: task };
      } catch (error) {
        logMessage(`Error adding items to task: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 从任务中移除项目
  ipcMain.handle(
    'removeItemFromTask',
    async (
      _event,
      {
        taskId,
        itemId,
      }: {
        taskId: string;
        itemId: string;
      },
    ) => {
      try {
        logMessage(`Removing item ${itemId} from task ${taskId}`, 'info');
        const task = removeItemFromTask(taskId, itemId);
        return { success: true, data: task };
      } catch (error) {
        logMessage(`Error removing item from task: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 获取任务进度
  ipcMain.handle(
    'getTaskProgress',
    async (_event, { taskId }: { taskId: string }) => {
      try {
        const task = getProofreadTaskById(taskId);
        if (!task) {
          return { success: false, error: 'Task not found' };
        }
        const progress = getTaskProgress(task);
        return { success: true, data: progress };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  // ============ 兼容旧版本 ============

  // 获取旧版历史记录（用于迁移）
  ipcMain.handle('getProofreadHistories', async () => {
    try {
      const histories = getProofreadHistories();
      return { success: true, data: histories };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 清空旧版历史记录
  ipcMain.handle('clearProofreadHistories', async () => {
    try {
      clearProofreadHistories();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ============ AI 优化相关 ============

  // 获取可用的 AI 翻译服务商列表
  ipcMain.handle('getAiTranslationProviders', async () => {
    try {
      const providers = store.get('translationProviders') || [];
      const aiProviders = providers.filter((p: Provider) => p.isAi);
      return { success: true, data: aiProviders };
    } catch (error) {
      logMessage(`Error getting AI providers: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  // 优化单条字幕翻译
  ipcMain.handle(
    'optimizeSubtitle',
    async (
      _event,
      {
        sourceText,
        targetText,
        providerId,
        customPrompt,
      }: {
        sourceText: string;
        targetText: string;
        providerId?: string;
        customPrompt?: string;
      },
    ) => {
      try {
        logMessage(`Optimizing subtitle translation`, 'info');

        // 获取用户配置
        const userConfig = store.get('userConfig') || {};

        // 使用传入的 providerId 或用户配置中的默认服务商
        const translateProviderId = providerId || userConfig.translateProvider;

        if (!translateProviderId || translateProviderId === '-1') {
          return {
            success: false,
            error: '请先选择一个 AI 翻译服务',
          };
        }

        // 获取翻译提供商
        const providers = store.get('translationProviders') || [];
        const provider = providers.find(
          (p: Provider) => p.id === translateProviderId,
        );

        if (!provider) {
          return {
            success: false,
            error: '未找到选择的翻译服务',
          };
        }

        // 检查是否为 AI 翻译服务
        if (!provider.isAi) {
          return {
            success: false,
            error: 'AI 优化功能仅支持 AI 翻译服务（如 OpenAI、Ollama 等）',
          };
        }

        // 获取翻译器
        const translator =
          TRANSLATOR_MAP[provider.type as keyof typeof TRANSLATOR_MAP];
        if (!translator) {
          return {
            success: false,
            error: `不支持的翻译服务类型: ${provider.type}`,
          };
        }

        // 获取源语言和目标语言
        const sourceLanguage = userConfig.sourceLanguage || 'en';
        const targetLanguage = userConfig.targetLanguage || 'zh';

        // 根据是否有翻译内容选择不同的默认提示词
        const hasTranslation = targetText && targetText.trim();
        const defaultPrompt = hasTranslation
          ? `You are a professional subtitle translator and proofreader. Your task is to improve the translation of the following subtitle.

Original text (${sourceLanguage}):
${sourceText}

Current translation (${targetLanguage}):
${targetText}

Please provide an improved translation that:
1. More accurately conveys the meaning of the original
2. Uses natural and fluent ${targetLanguage} expressions
3. Is appropriate for subtitle display (concise but complete)
4. Maintains the tone and style of the original

Only respond with the improved translation, nothing else.`
          : `You are a professional subtitle translator. Your task is to translate the following subtitle.

Original text (${sourceLanguage}):
${sourceText}

Please translate to ${targetLanguage}:
1. Accurately convey the meaning of the original
2. Use natural and fluent ${targetLanguage} expressions
3. Be appropriate for subtitle display (concise but complete)
4. Maintain the tone and style of the original

Only respond with the translation, nothing else.`;

        // 如果有自定义提示词，替换变量
        let optimizePrompt = defaultPrompt;
        if (customPrompt && customPrompt.trim()) {
          // 处理简单的条件模板 {{#if targetText}}...{{else}}...{{/if}}
          let processedPrompt = customPrompt;
          if (hasTranslation) {
            // 有翻译内容：保留 if 块，移除 else 块
            processedPrompt = processedPrompt.replace(
              /\{\{#if\s+targetText\}\}([\s\S]*?)\{\{else\}\}[\s\S]*?\{\{\/if\}\}/g,
              '$1',
            );
          } else {
            // 无翻译内容：移除 if 块，保留 else 块
            processedPrompt = processedPrompt.replace(
              /\{\{#if\s+targetText\}\}[\s\S]*?\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
              '$1',
            );
          }

          optimizePrompt = processedPrompt
            .replace(/\{\{sourceLanguage\}\}/g, sourceLanguage)
            .replace(/\{\{targetLanguage\}\}/g, targetLanguage)
            .replace(/\{\{sourceText\}\}/g, sourceText)
            .replace(/\{\{targetText\}\}/g, targetText || '');
        }

        // 调用翻译服务
        const optimizedProvider = {
          ...provider,
          systemPrompt:
            'You are a professional subtitle translation optimizer. Provide improved translations only, no explanations.',
          useJsonMode: false,
          structuredOutput: 'disabled' as const,
        };

        const result = await translator(
          optimizePrompt,
          optimizedProvider,
          sourceLanguage,
          targetLanguage,
        );

        if (result) {
          // 清理结果，移除可能的引号或多余空白
          const cleanedResult = result
            .trim()
            .replace(/^["']|["']$/g, '')
            .trim();
          logMessage(`Subtitle optimization successful`, 'info');
          return { success: true, data: cleanedResult };
        } else {
          return {
            success: false,
            error: 'AI 优化返回空结果',
          };
        }
      } catch (error) {
        logMessage(`Error optimizing subtitle: ${error}`, 'error');
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  logMessage('Proofread IPC handlers initialized', 'info');
}
