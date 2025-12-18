import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createMessageSender } from './messageHandler';
import { logMessage } from './storeManager';
import { readFileContent, wrapFileObject } from './fileUtils';
import { CONTENT_TEMPLATES } from '../translate/constants';
import { renderTemplate } from './utils';
import { parseSubtitles } from '../translate/utils/subtitle';

// 定义支持的文件扩展名常量
export const MEDIA_EXTENSIONS = [
  // 视频格式
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.flv',
  '.wmv',
  '.webm',
  // 音频格式
  '.mp3',
  '.wav',
  '.ogg',
  '.aac',
  '.wma',
  '.flac',
  '.m4a',
  '.aiff',
  '.ape',
  '.opus',
  '.ac3',
  '.amr',
  '.au',
  '.mid',
  // 其他常见视频格式
  '.3gp',
  '.asf',
  '.rm',
  '.rmvb',
  '.vob',
  '.ts',
  '.mts',
  '.m2ts',
];

export const SUBTITLE_EXTENSIONS = [
  // 字幕格式
  '.srt',
  '.vtt',
  '.ass',
  '.ssa',
];

// 判断文件是否为媒体文件
export function isMediaFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.includes(ext);
}

// 判断文件是否为字幕文件
export function isSubtitleFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUBTITLE_EXTENSIONS.includes(ext);
}

// 递归获取文件夹中的符合任务类型的文件
async function getMediaFilesFromDirectory(
  directoryPath: string,
  taskType: string,
): Promise<string[]> {
  // 根据任务类型选择扩展名
  const supportedExtensions =
    taskType === 'translate' ? SUBTITLE_EXTENSIONS : MEDIA_EXTENSIONS;

  const files: string[] = [];

  try {
    const entries = await fs.promises.readdir(directoryPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        // 递归处理子目录
        const subDirFiles = await getMediaFilesFromDirectory(
          fullPath,
          taskType,
        );
        files.push(...subDirFiles);
      } else if (entry.isFile()) {
        // 检查文件扩展名是否受支持
        const ext = path.extname(entry.name).toLowerCase();
        if (supportedExtensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    console.error(`读取目录 ${directoryPath} 时出错:`, error);
  }

  return files;
}

export function setupIpcHandlers(mainWindow: BrowserWindow) {
  ipcMain.on('message', async (event, arg) => {
    event.reply('message', `${arg} World!`);
  });

  ipcMain.on('openDialog', async (event, data) => {
    const { fileType } = data;
    console.log(fileType, 'fileType');
    const name = fileType === 'srt' ? 'Subtitle Files' : 'Media Files';

    // 使用已定义的常量获取扩展名
    const extensions =
      fileType === 'srt'
        ? SUBTITLE_EXTENSIONS.map((ext) => ext.substring(1)) // 移除前面的点
        : MEDIA_EXTENSIONS.map((ext) => ext.substring(1));

    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: name,
          extensions: extensions,
        },
      ],
    });

    try {
      event.sender.send('file-selected', result.filePaths.map(wrapFileObject));
    } catch (error) {
      createMessageSender(event.sender).send('message', {
        type: 'error',
        message: error.message,
      });
    }
  });

  ipcMain.on('openUrl', (event, url) => {
    shell.openExternal(url);
  });

  ipcMain.handle('getDroppedFiles', async (event, { files, taskType }) => {
    // 处理文件和文件夹
    const allValidPaths: string[] = [];

    for (const filePath of files) {
      try {
        const stats = await fs.promises.stat(filePath);

        if (stats.isDirectory()) {
          // 如果是文件夹，递归获取所有符合任务类型的文件
          const filteredFiles = await getMediaFilesFromDirectory(
            filePath,
            taskType,
          );
          allValidPaths.push(...filteredFiles);
        } else if (stats.isFile()) {
          // 如果是文件，根据任务类型过滤
          // 根据任务类型决定添加哪种文件
          if (
            (taskType === 'translate' && isSubtitleFile(filePath)) ||
            (taskType !== 'translate' && isMediaFile(filePath))
          ) {
            allValidPaths.push(filePath);
          }
        }
      } catch {
        // 如果访问失败，跳过此路径
        continue;
      }
    }

    return allValidPaths.map(wrapFileObject);
  });

  // 读取字幕文件
  ipcMain.handle('readSubtitleFile', async (event, { filePath }) => {
    try {
      if (!fs.existsSync(filePath)) {
        logMessage(`读取字幕文件失败: 文件不存在 ${filePath}`, 'error');
        return [];
      }
      const content = await readFileContent(filePath);
      return parseSubtitles(content);
    } catch (error) {
      logMessage(`读取字幕文件错误: ${error.message}`, 'error');
      return [];
    }
  });

  // 读取文件原始内容
  ipcMain.handle('readRawFileContent', async (event, { filePath }) => {
    try {
      if (!fs.existsSync(filePath)) {
        logMessage(`读取文件失败: 文件不存在 ${filePath}`, 'error');
        return { error: `File not found: ${filePath}` };
      }
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { content };
    } catch (error) {
      logMessage(`读取文件错误: ${error.message}`, 'error');
      return { error: `Error reading file: ${error.message}` };
    }
  });

  // 保存字幕文件
  ipcMain.handle(
    'saveSubtitleFile',
    async (event, { filePath, subtitles, contentType = 'source' }) => {
      try {
        const content = subtitles
          .map(
            (subtitle) =>
              `${subtitle.id}\n${subtitle.startEndTime}\n${
                contentType === 'source'
                  ? `${subtitle.sourceContent}\n\n`
                  : renderTemplate(CONTENT_TEMPLATES[contentType], {
                      sourceContent: subtitle.sourceContent,
                      targetContent: subtitle.targetContent,
                    })
              }`,
          )
          .join('');
        console.log('saveSubtitleFile', filePath, content);
        await fs.promises.writeFile(filePath, content, 'utf-8');
        logMessage(`保存字幕文件成功: ${filePath}`, 'info');
        return { success: true };
      } catch (error) {
        logMessage(`保存字幕文件错误: ${error.message}`, 'error');
        return {
          error: `保存字幕文件错误: ${error.message}`,
        };
      }
    },
  );

  // 检查文件是否存在
  ipcMain.handle('checkFileExists', async (event, { filePath }) => {
    try {
      const exists = fs.existsSync(filePath);
      return { exists };
    } catch (error) {
      logMessage(`检查文件是否存在错误: ${error.message}`, 'error');
      return { exists: false, error: error.message };
    }
  });

  // 获取目录中的文件列表
  ipcMain.handle('getDirectoryFiles', async (event, { directoryPath }) => {
    try {
      const files = await fs.promises.readdir(directoryPath);
      return { files };
    } catch (error) {
      logMessage(`获取目录文件列表错误: ${error.message}`, 'error');
      return { files: [], error: error.message };
    }
  });

  ipcMain.handle(
    'selectDirectory',
    async (event, options?: { title?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: options?.title,
      });
      return {
        directoryPath: result.filePaths[0] || null,
        canceled: result.canceled,
      };
    },
  );

  // 选择单个文件
  ipcMain.handle(
    'selectFile',
    async (
      event,
      options: { type: 'video' | 'subtitle' | 'any'; title?: string },
    ) => {
      const { type, title } = options;

      let filters: { name: string; extensions: string[] }[] = [];

      if (type === 'video') {
        filters = [
          {
            name: 'Video Files',
            extensions: MEDIA_EXTENSIONS.filter((ext) =>
              [
                '.mp4',
                '.avi',
                '.mov',
                '.mkv',
                '.flv',
                '.wmv',
                '.webm',
                '.3gp',
                '.ts',
              ].includes(ext),
            ).map((ext) => ext.substring(1)),
          },
        ];
      } else if (type === 'subtitle') {
        filters = [
          {
            name: 'Subtitle Files',
            extensions: SUBTITLE_EXTENSIONS.map((ext) => ext.substring(1)),
          },
        ];
      }

      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title,
        filters: filters.length > 0 ? filters : undefined,
      });

      return {
        filePath: result.filePaths[0] || null,
        canceled: result.canceled,
      };
    },
  );

  // 选择多个文件
  ipcMain.handle(
    'selectFiles',
    async (
      event,
      options: {
        type: 'video' | 'subtitle' | 'any';
        title?: string;
        multiple?: boolean;
      },
    ) => {
      const { type, title, multiple = true } = options;

      let filters: { name: string; extensions: string[] }[] = [];

      if (type === 'video') {
        filters = [
          {
            name: 'Video Files',
            extensions: MEDIA_EXTENSIONS.filter((ext) =>
              [
                '.mp4',
                '.avi',
                '.mov',
                '.mkv',
                '.flv',
                '.wmv',
                '.webm',
                '.3gp',
                '.ts',
              ].includes(ext),
            ).map((ext) => ext.substring(1)),
          },
        ];
      } else if (type === 'subtitle') {
        filters = [
          {
            name: 'Subtitle Files',
            extensions: SUBTITLE_EXTENSIONS.map((ext) => ext.substring(1)),
          },
        ];
      }

      const properties: ('openFile' | 'multiSelections')[] = ['openFile'];
      if (multiple) {
        properties.push('multiSelections');
      }

      const result = await dialog.showOpenDialog({
        properties,
        title,
        filters: filters.length > 0 ? filters : undefined,
      });

      return {
        filePaths: result.filePaths,
        canceled: result.canceled,
      };
    },
  );
}
