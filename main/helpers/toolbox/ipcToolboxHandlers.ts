/**
 * 工具箱 IPC 统一处理函数
 *
 * 注册 toolbox:* 命名空间，提供文件对话框、转码调度、进度推送及任务取消能力。
 */

import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { logMessage } from '../logger';
import {
  detectSubtitleFileEncoding,
  previewSubtitleFile,
  convertSubtitleFile,
  batchConvertSubtitles,
} from './subtitleConverter';
import {
  probeVideoInfo,
  executeVideoTrim,
  cancelVideoTrim,
  cancelAllTrimProcesses,
} from './videoTrimmer';
import {
  executeAudioExtract,
  cancelAudioExtract,
  cancelAllAudioProcesses,
} from './audioExtractor';
import {
  scanEmbeddedSubtitles,
  extractEmbeddedSubtitles,
} from './embeddedSubtitleExtractor';
import { executeSubtitleSync } from './subtitleSync';
import {
  mergeBilingualSubtitles,
  splitBilingualSubtitles,
} from './bilingualSubtitles';
import {
  executeVideoCompress,
  cancelVideoCompress,
  cancelAllCompressProcesses,
} from './videoCompressor';
import {
  executeVideoToGif,
  cancelVideoToGif,
  cancelAllGifProcesses,
} from './videoToGif';
import type {
  SubtitleConvertItemConfig,
  VideoTrimConfig,
  AudioExtractConfig,
  ExtractEmbeddedSubtitleConfig,
  SubtitleSyncConfig,
  BilingualSubtitleMergeConfig,
  BilingualSubtitleSplitConfig,
  VideoCompressConfig,
  VideoToGifConfig,
} from '../../../types/toolbox';

export function setupToolboxHandlers(mainWindow?: BrowserWindow | null): void {
  // 1. 选择文件对话框
  ipcMain.handle(
    'toolbox:selectFile',
    async (
      _event,
      payload: {
        type: 'subtitle' | 'video' | 'audio' | 'all';
        multiSelections?: boolean;
      },
    ) => {
      const filters = [];
      if (payload.type === 'subtitle') {
        filters.push({
          name: 'Subtitle Files',
          extensions: ['srt', 'vtt', 'ass', 'ssa', 'lrc', 'txt'],
        });
      } else if (payload.type === 'video') {
        filters.push({
          name: 'Video Files',
          extensions: [
            'mp4',
            'mkv',
            'webm',
            'mov',
            'avi',
            'flv',
            'ts',
            'm4v',
            'wmv',
          ],
        });
      } else if (payload.type === 'audio') {
        filters.push({
          name: 'Audio Files',
          extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'wma'],
        });
      } else {
        filters.push({
          name: 'Media & Subtitle Files',
          extensions: ['*'],
        });
      }

      const properties: Array<'openFile' | 'multiSelections'> = ['openFile'];
      if (payload.multiSelections) {
        properties.push('multiSelections');
      }

      const res = await dialog.showOpenDialog(mainWindow || undefined as any, {
        properties,
        filters,
      });

      if (res.canceled) return [];
      return res.filePaths;
    },
  );

  // 2. 选择目录
  ipcMain.handle('toolbox:selectFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow || undefined as any, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled) return null;
    return res.filePaths[0] || null;
  });

  // 3. 打开所在目录
  ipcMain.handle('toolbox:openFolder', async (_event, filePath: string) => {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          await shell.openPath(filePath);
        } else {
          shell.showItemInFolder(filePath);
        }
        return true;
      }
      // 如果文件不存在但目录存在，打开父级目录
      const parent = path.dirname(filePath);
      if (fs.existsSync(parent)) {
        await shell.openPath(parent);
        return true;
      }
      return false;
    } catch (err) {
      logMessage(`toolbox:openFolder error: ${err}`, 'warning');
      return false;
    }
  });

  // 4. 字幕探测与转换
  ipcMain.handle('toolbox:detectEncoding', async (_event, filePath: string) => {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return detectSubtitleFileEncoding(filePath);
  });

  ipcMain.handle(
    'toolbox:previewSubtitle',
    async (
      _event,
      payload: { filePath: string; forcedEncoding?: string; limit?: number },
    ) => {
      if (!payload?.filePath || !fs.existsSync(payload.filePath)) {
        throw new Error(`File not found: ${payload?.filePath}`);
      }
      return previewSubtitleFile(
        payload.filePath,
        payload.forcedEncoding,
        payload.limit,
      );
    },
  );

  ipcMain.handle(
    'toolbox:convertSubtitleFile',
    async (_event, config: SubtitleConvertItemConfig) => {
      if (!config?.filePath || !fs.existsSync(config.filePath)) {
        return {
          success: false,
          sourcePath: config?.filePath || '',
          error: `File not found: ${config?.filePath}`,
        };
      }
      return convertSubtitleFile(config);
    },
  );

  ipcMain.handle(
    'toolbox:batchConvertSubtitles',
    async (_event, configs: SubtitleConvertItemConfig[]) => {
      return batchConvertSubtitles(configs || []);
    },
  );

  // 5. 视频裁剪
  ipcMain.handle('toolbox:getVideoInfo', async (_event, videoPath: string) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }
    return probeVideoInfo(videoPath);
  });

  ipcMain.handle(
    'toolbox:trimVideo',
    async (
      _event,
      payload: { config: VideoTrimConfig; jobId: string },
    ) => {
      const { config, jobId } = payload;
      if (!config?.videoPath || !fs.existsSync(config.videoPath)) {
        return {
          success: false,
          outputPath: '',
          duration: 0,
          size: 0,
          error: `Video file not found: ${config?.videoPath}`,
        };
      }
      return executeVideoTrim(config, jobId, (progress) => {
        mainWindow?.webContents.send('toolbox:trimProgress', {
          jobId,
          ...progress,
        });
      });
    },
  );

  ipcMain.handle('toolbox:cancelTrimVideo', async (_event, jobId: string) => {
    return cancelVideoTrim(jobId);
  });

  // 6. 音频提取
  ipcMain.handle(
    'toolbox:extractAudio',
    async (
      _event,
      payload: { config: AudioExtractConfig; jobId: string },
    ) => {
      const { config, jobId } = payload;
      if (!config?.videoPath || !fs.existsSync(config.videoPath)) {
        return {
          success: false,
          outputPath: '',
          format: config?.format || 'mp3',
          size: 0,
          error: `Video file not found: ${config?.videoPath}`,
        };
      }
      return executeAudioExtract(config, jobId, (percent) => {
        mainWindow?.webContents.send('toolbox:audioProgress', {
          jobId,
          percent,
        });
      });
    },
  );

  ipcMain.handle('toolbox:cancelExtractAudio', async (_event, jobId: string) => {
    return cancelAudioExtract(jobId);
  });

  // 7. 内封字幕探测与提取
  ipcMain.handle(
    'toolbox:scanEmbeddedSubtitles',
    async (_event, videoPath: string) => {
      if (!videoPath || !fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }
      return scanEmbeddedSubtitles(videoPath);
    },
  );

  ipcMain.handle(
    'toolbox:extractEmbeddedSubtitles',
    async (_event, config: ExtractEmbeddedSubtitleConfig) => {
      if (!config?.videoPath || !fs.existsSync(config.videoPath)) {
        return {
          success: false,
          extractedFiles: [],
          error: `Video file not found: ${config?.videoPath}`,
        };
      }
      return extractEmbeddedSubtitles(config);
    },
  );

  // 8. 字幕时间轴校准
  ipcMain.handle(
    'toolbox:syncSubtitleTime',
    async (_event, config: SubtitleSyncConfig) => {
      return executeSubtitleSync(config);
    },
  );

  // 9. 双语字幕合并与拆分
  ipcMain.handle(
    'toolbox:mergeBilingualSubtitles',
    async (_event, config: BilingualSubtitleMergeConfig) => {
      return mergeBilingualSubtitles(config);
    },
  );

  ipcMain.handle(
    'toolbox:splitBilingualSubtitles',
    async (_event, config: BilingualSubtitleSplitConfig) => {
      return splitBilingualSubtitles(config);
    },
  );

  // 10. 视频压缩
  ipcMain.handle(
    'toolbox:compressVideo',
    async (
      _event,
      payload: { config: VideoCompressConfig; jobId: string },
    ) => {
      const { config, jobId } = payload;
      return executeVideoCompress(config, jobId, (percent) => {
        mainWindow?.webContents.send('toolbox:compressProgress', {
          jobId,
          percent,
        });
      });
    },
  );

  ipcMain.handle('toolbox:cancelCompressVideo', async (_event, jobId: string) => {
    return cancelVideoCompress(jobId);
  });

  // 11. 视频转 GIF
  ipcMain.handle(
    'toolbox:videoToGif',
    async (
      _event,
      payload: { config: VideoToGifConfig; jobId: string },
    ) => {
      const { config, jobId } = payload;
      return executeVideoToGif(config, jobId, (percent) => {
        mainWindow?.webContents.send('toolbox:gifProgress', {
          jobId,
          percent,
        });
      });
    },
  );

  ipcMain.handle('toolbox:cancelVideoToGif', async (_event, jobId: string) => {
    return cancelVideoToGif(jobId);
  });

  logMessage('Toolbox IPC handlers registered successfully', 'info');
}

/**
 * 应用退出时统一清理所有正在运行的工具箱子进程
 */
export function shutdownToolboxProcesses(): void {
  try {
    cancelAllTrimProcesses();
    cancelAllAudioProcesses();
    cancelAllCompressProcesses();
    cancelAllGifProcesses();
    logMessage('All active toolbox processes have been shut down cleanly', 'info');
  } catch (err) {
    logMessage(`Error shutting down toolbox processes: ${err}`, 'warning');
  }
}
