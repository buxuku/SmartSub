/**
 * 字幕合并功能 IPC 处理函数
 */

import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { logMessage } from './storeManager';
import {
  getVideoInfo,
  mergeSubtitleToVideo,
  generateOutputPath,
  getSubtitleFormat,
  countSubtitles,
} from './subtitleMerger';
import type {
  MergeConfig,
  MergeProgress,
  SubtitleMergeResponse,
  VideoInfo,
  SubtitleInfo,
} from '../../types/subtitleMerge';

// 存储当前进度回调
let currentProgressCallback: ((progress: MergeProgress) => void) | null = null;

/**
 * 设置字幕合并相关的 IPC 处理函数
 */
export function setupSubtitleMergeHandlers(mainWindow: BrowserWindow) {
  // 获取视频信息
  ipcMain.handle(
    'subtitleMerge:getVideoInfo',
    async (event, { videoPath }): Promise<SubtitleMergeResponse<VideoInfo>> => {
      try {
        if (!fs.existsSync(videoPath)) {
          return { success: false, error: '视频文件不存在' };
        }
        const info = await getVideoInfo(videoPath);
        return { success: true, data: info };
      } catch (error) {
        logMessage(`获取视频信息失败: ${error}`, 'error');
        return { success: false, error: `获取视频信息失败: ${error}` };
      }
    },
  );

  // 获取字幕文件信息
  ipcMain.handle(
    'subtitleMerge:getSubtitleInfo',
    async (
      event,
      { subtitlePath },
    ): Promise<SubtitleMergeResponse<SubtitleInfo>> => {
      try {
        if (!fs.existsSync(subtitlePath)) {
          return { success: false, error: '字幕文件不存在' };
        }

        const count = await countSubtitles(subtitlePath);
        const format = getSubtitleFormat(subtitlePath);

        return {
          success: true,
          data: {
            path: subtitlePath,
            fileName: path.basename(subtitlePath),
            count,
            format,
          },
        };
      } catch (error) {
        logMessage(`获取字幕信息失败: ${error}`, 'error');
        return { success: false, error: `获取字幕信息失败: ${error}` };
      }
    },
  );

  // 开始合并字幕
  ipcMain.handle(
    'subtitleMerge:startMerge',
    async (
      event,
      config: MergeConfig,
    ): Promise<SubtitleMergeResponse<string>> => {
      try {
        if (!fs.existsSync(config.videoPath)) {
          return { success: false, error: '视频文件不存在' };
        }
        if (!fs.existsSync(config.subtitlePath)) {
          return { success: false, error: '字幕文件不存在' };
        }

        // 如果没有指定输出路径，自动生成
        const outputPath =
          config.outputPath || generateOutputPath(config.videoPath);

        // 确保输出目录存在
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
          await fs.promises.mkdir(outputDir, { recursive: true });
        }

        // 设置进度回调
        currentProgressCallback = (progress: MergeProgress) => {
          mainWindow.webContents.send('subtitleMerge:progress', progress);
        };

        const result = await mergeSubtitleToVideo(
          { ...config, outputPath },
          currentProgressCallback,
        );

        currentProgressCallback = null;
        return { success: true, data: result };
      } catch (error) {
        currentProgressCallback = null;
        logMessage(`合并失败: ${error}`, 'error');
        return { success: false, error: `合并失败: ${error}` };
      }
    },
  );

  // 选择输出路径
  ipcMain.handle(
    'subtitleMerge:selectOutputPath',
    async (event, { defaultPath }): Promise<SubtitleMergeResponse<string>> => {
      try {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '选择保存位置',
          defaultPath: defaultPath || undefined,
          filters: [
            { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'mov'] },
          ],
        });

        if (result.canceled || !result.filePath) {
          return { success: false, error: '用户取消选择' };
        }

        return { success: true, data: result.filePath };
      } catch (error) {
        logMessage(`选择输出路径失败: ${error}`, 'error');
        return { success: false, error: `选择输出路径失败: ${error}` };
      }
    },
  );

  // 生成默认输出路径
  ipcMain.handle(
    'subtitleMerge:generateOutputPath',
    async (
      event,
      { videoPath, suffix },
    ): Promise<SubtitleMergeResponse<string>> => {
      try {
        const outputPath = generateOutputPath(videoPath, suffix);
        return { success: true, data: outputPath };
      } catch (error) {
        return { success: false, error: `生成输出路径失败: ${error}` };
      }
    },
  );

  // 打开输出文件所在目录
  ipcMain.handle(
    'subtitleMerge:openOutputFolder',
    async (event, { filePath }): Promise<SubtitleMergeResponse<boolean>> => {
      try {
        shell.showItemInFolder(filePath);
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: `打开目录失败: ${error}` };
      }
    },
  );

  logMessage('字幕合并 IPC 处理函数已注册', 'info');
}
