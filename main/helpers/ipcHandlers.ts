import { app, ipcMain, BrowserWindow, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createMessageSender } from './messageHandler';
import { logMessage } from './storeManager';
import { wrapFileObject, ensureTempDir, getMd5 } from './fileUtils';
import { CONTENT_TEMPLATES } from '../translate/constants';
import { renderTemplate, getExtraResourcesPath } from './utils';
import {
  detectSubtitleFormat,
  detectSubtitleFormatFromContent,
  parseSubtitleEntries,
  parseStartEndTime,
  getSubtitleFileHeader,
  serializeCue,
  convertSubtitleContent,
} from './subtitleFormats';
import {
  proofreadDataToSubtitleRows,
  readProofreadDataFile,
  updateProofreadDataFromSubtitles,
} from './proofreadData';

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
  '.lrc',
];

const IMPORTABLE_SUBTITLE_EXTENSIONS = [...SUBTITLE_EXTENSIONS, '.txt'];
const SUBTITLE_CONTENT_PROBE_BYTES = 50 * 1024;

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

async function readSubtitleProbeContent(filePath: string): Promise<string> {
  const fileHandle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(SUBTITLE_CONTENT_PROBE_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await fileHandle.close();
  }
}

async function isImportableSubtitleFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMPORTABLE_SUBTITLE_EXTENSIONS.includes(ext)) return false;
  if (ext !== '.txt') return true;

  try {
    const content = await readSubtitleProbeContent(filePath);
    return detectSubtitleFormatFromContent(filePath, content) !== 'txt';
  } catch {
    return false;
  }
}

// 递归获取文件夹中的符合任务类型的文件
async function getMediaFilesFromDirectory(
  directoryPath: string,
  taskType: string,
): Promise<string[]> {
  // 根据任务类型选择扩展名
  const supportedExtensions =
    taskType === 'translate'
      ? IMPORTABLE_SUBTITLE_EXTENSIONS
      : MEDIA_EXTENSIONS;

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
        if (
          taskType === 'translate'
            ? await isImportableSubtitleFile(fullPath)
            : supportedExtensions.includes(
                path.extname(entry.name).toLowerCase(),
              )
        ) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    console.error(`读取目录 ${directoryPath} 时出错:`, error);
  }

  return files;
}

function buildSubtitleFileContent(
  filePath: string,
  subtitles: any[],
  contentType = 'source',
): string {
  const format = detectSubtitleFormat(filePath);
  const buildText = (subtitle): string => {
    if (contentType === 'source') {
      return subtitle.sourceContent ?? '';
    }
    const template =
      CONTENT_TEMPLATES[contentType] || CONTENT_TEMPLATES.onlyTranslate;
    return renderTemplate(template, {
      sourceContent: subtitle.sourceContent ?? '',
      targetContent: subtitle.targetContent ?? '',
    }).replace(/\n+$/, '');
  };

  return (
    getSubtitleFileHeader(format) +
    subtitles
      .map((subtitle) => {
        const { startMs, endMs } = parseStartEndTime(subtitle.startEndTime);
        return serializeCue(
          {
            id: subtitle.id,
            startMs,
            endMs,
            text: buildText(subtitle),
          },
          format,
        );
      })
      .join('')
  );
}

async function backupSubtitleFile(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      const backupPath = path.join(
        ensureTempDir(),
        `subtitle-backup-${getMd5(filePath)}${path.extname(filePath)}.bak`,
      );
      await fs.promises.copyFile(filePath, backupPath);
    }
  } catch (backupError) {
    logMessage(
      `备份字幕文件失败（继续保存）: ${backupError.message}`,
      'warning',
    );
  }
}

async function writeSubtitleFile(
  filePath: string,
  subtitles: any[],
  contentType = 'source',
): Promise<void> {
  const content = buildSubtitleFileContent(filePath, subtitles, contentType);
  await backupSubtitleFile(filePath);
  await fs.promises.writeFile(filePath, content, 'utf-8');
  logMessage(`保存字幕文件成功: ${filePath}`, 'info');
}

export function setupIpcHandlers(mainWindow: BrowserWindow) {
  ipcMain.on('message', async (event, arg) => {
    event.reply('message', `${arg} World!`);
  });

  ipcMain.on('openDialog', async (event, data) => {
    const { fileType } = data;
    console.log(fileType, 'fileType');
    const name = fileType === 'srt' ? 'Subtitle Files' : 'Media Files';
    const taskType = fileType === 'srt' ? 'translate' : 'media';

    const extensions =
      fileType === 'srt'
        ? IMPORTABLE_SUBTITLE_EXTENSIONS.map((ext) => ext.substring(1))
        : MEDIA_EXTENSIONS.map((ext) => ext.substring(1));

    // macOS 支持同时选择文件和文件夹；Windows/Linux 两者互斥，仅支持选择文件
    const properties: Electron.OpenDialogOptions['properties'] =
      process.platform === 'darwin'
        ? ['openFile', 'openDirectory', 'multiSelections']
        : ['openFile', 'multiSelections'];

    const result = await dialog.showOpenDialog({
      properties,
      filters: [
        {
          name: name,
          extensions: extensions,
        },
      ],
    });

    const allValidPaths: string[] = [];
    for (const filePath of result.filePaths) {
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
          const dirFiles = await getMediaFilesFromDirectory(filePath, taskType);
          allValidPaths.push(...dirFiles);
        } else if (
          stats.isFile() &&
          (taskType === 'translate'
            ? await isImportableSubtitleFile(filePath)
            : isMediaFile(filePath))
        ) {
          allValidPaths.push(filePath);
        }
      } catch (error) {
        console.error(`Failed to stat file ${filePath}:`, error);
      }
    }
    event.sender.send('file-selected', allValidPaths.map(wrapFileObject));
  });

  ipcMain.on('openUrl', (event, url) => {
    shell.openExternal(url);
  });

  // 引导「试一试」示例音频:复制到用户数据目录后返回——打包态 resources 目录只读,
  // 转写输出会写在媒体文件同目录,必须给它一个可写的家
  ipcMain.handle('getOnboardingSamplePath', async () => {
    const bundled = path.join(getExtraResourcesPath(), 'sample-onboarding.mp3');
    const sampleDir = path.join(app.getPath('userData'), 'sample');
    await fs.promises.mkdir(sampleDir, { recursive: true });
    const dest = path.join(sampleDir, 'sample-onboarding.mp3');
    await fs.promises.copyFile(bundled, dest);
    return dest;
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
            (taskType === 'translate' &&
              (await isImportableSubtitleFile(filePath))) ||
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

  // 读取字幕文件（按扩展名自动识别 srt/vtt/ass/lrc 格式）
  ipcMain.handle('readSubtitleFile', async (event, { filePath }) => {
    try {
      if (!fs.existsSync(filePath)) {
        logMessage(`读取字幕文件失败: 文件不存在 ${filePath}`, 'error');
        return [];
      }
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const format = detectSubtitleFormatFromContent(filePath, content);
      return parseSubtitleEntries(content, format);
    } catch (error) {
      logMessage(`读取字幕文件错误: ${error.message}`, 'error');
      return [];
    }
  });

  ipcMain.handle('readProofreadDataFile', async (event, { filePath }) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        logMessage(`读取校对中间态失败: 文件不存在 ${filePath}`, 'error');
        return [];
      }
      const proofreadData = await readProofreadDataFile(filePath);
      return proofreadDataToSubtitleRows(proofreadData);
    } catch (error) {
      logMessage(`读取校对中间态错误: ${error.message}`, 'error');
      return [];
    }
  });

  // 读取任意字幕文件并转换为 WebVTT 文本（供播放器内嵌字幕轨道使用）
  ipcMain.handle('getSubtitleAsVtt', async (event, { filePath }) => {
    try {
      if (!fs.existsSync(filePath)) {
        return { error: `File not found: ${filePath}` };
      }
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const format = detectSubtitleFormatFromContent(filePath, content);
      const vtt = convertSubtitleContent(content, format, 'vtt');
      return { content: vtt };
    } catch (error) {
      logMessage(`转换字幕为 VTT 失败: ${error.message}`, 'error');
      return { error: `Error converting subtitle: ${error.message}` };
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

  // 保存字幕文件（按目标文件扩展名序列化为对应格式）
  ipcMain.handle(
    'saveSubtitleFile',
    async (event, { filePath, subtitles, contentType = 'source' }) => {
      try {
        await writeSubtitleFile(filePath, subtitles, contentType);
        return { success: true };
      } catch (error) {
        logMessage(`保存字幕文件错误: ${error.message}`, 'error');
        return {
          error: `保存字幕文件错误: ${error.message}`,
        };
      }
    },
  );

  ipcMain.handle(
    'saveProofreadDataAndRender',
    async (
      event,
      {
        proofreadDataFile,
        subtitles,
        outputs = [],
      }: {
        proofreadDataFile: string;
        subtitles: any[];
        outputs: { filePath?: string; contentType?: string }[];
      },
    ) => {
      try {
        if (!proofreadDataFile || !fs.existsSync(proofreadDataFile)) {
          throw new Error(
            `Proofread data file not found: ${proofreadDataFile}`,
          );
        }

        await updateProofreadDataFromSubtitles(proofreadDataFile, subtitles);

        const rendered = new Set<string>();
        for (const output of outputs) {
          const filePath = output?.filePath;
          if (!filePath) continue;
          const key = path.resolve(filePath).toLowerCase();
          if (rendered.has(key)) continue;
          rendered.add(key);
          await writeSubtitleFile(
            filePath,
            subtitles,
            output.contentType || 'source',
          );
        }

        return { success: true };
      } catch (error) {
        logMessage(`保存校对中间态错误: ${error.message}`, 'error');
        return {
          error: `保存校对中间态错误: ${error.message}`,
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
            name: 'Media Files',
            extensions: MEDIA_EXTENSIONS.map((ext) => ext.substring(1)),
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
      const selectedPath = result.filePaths[0] || null;
      const filePath =
        type === 'subtitle' && selectedPath
          ? (await isImportableSubtitleFile(selectedPath))
            ? selectedPath
            : null
          : selectedPath;

      return {
        filePath,
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
            name: 'Media Files',
            extensions: MEDIA_EXTENSIONS.map((ext) => ext.substring(1)),
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
      const filePaths =
        type === 'subtitle'
          ? (
              await Promise.all(
                result.filePaths.map(async (filePath) =>
                  (await isImportableSubtitleFile(filePath)) ? filePath : null,
                ),
              )
            ).filter((filePath): filePath is string => Boolean(filePath))
          : result.filePaths;

      return {
        filePaths,
        canceled: result.canceled,
      };
    },
  );
}
