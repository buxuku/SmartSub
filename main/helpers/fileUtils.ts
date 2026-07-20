import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { logMessage, store } from './storeManager';
import { resolveTempDir } from './storagePaths';

/**
 * 计算字符串的MD5哈希值
 */
export function getMd5(str: string) {
  return createHash('md5').update(str).digest('hex');
}

/**
 * 将 ffmpeg 的时间标记（HH:MM:SS.xx / MM:SS / 纯秒数）转换为秒。
 * 用于在 fluent-ffmpeg 的 progress.percent 不可用时，根据 timemark 与总时长自算进度。
 */
export function timemarkToSeconds(timemark: string | number): number {
  if (typeof timemark === 'number')
    return Number.isFinite(timemark) ? timemark : 0;
  if (!timemark) return 0;
  const parts = timemark.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * 获取临时目录路径。
 * 三级解析（storagePaths.resolveTempDir）：自定义临时目录 > 统一存储目录/temp > 系统默认。
 */
export function getTempDir() {
  const settings = store.get('settings');
  const resolved = resolveTempDir({
    useCustomTempDir: settings?.useCustomTempDir,
    customTempDir: settings?.customTempDir,
    storageRoot: settings?.storageRoot,
    systemTempDir: app.getPath('temp'),
  });

  // 非默认目录创建失败时回退系统默认（沿用既有自定义临时目录的失败语义）
  if (resolved.source !== 'default' && !fs.existsSync(resolved.path)) {
    try {
      fs.mkdirSync(resolved.path, { recursive: true });
    } catch (error) {
      logMessage(
        `无法创建临时目录(${resolved.source}): ${error.message}，将使用默认临时目录`,
        'error',
      );
      return path.join(app.getPath('temp'), 'whisper-subtitles');
    }
  }
  return resolved.path;
}

/**
 * 确保临时目录存在
 */
export function ensureTempDir() {
  const tempDir = getTempDir();
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

/**
 * 格式化SRT内容
 */
export function subtitleTimeToSeconds(time?: string): number | null {
  if (!time) return null;
  const normalized = time.trim().replace(',', '.');
  const parts = normalized.split(':').map((part) => Number(part));
  if (!parts.length || parts.some((part) => Number.isNaN(part))) return null;

  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

export function secondsToSubtitleTime(seconds: number) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const displaySeconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
    2,
    '0',
  )}:${String(displaySeconds).padStart(2, '0')},${String(milliseconds).padStart(
    3,
    '0',
  )}`;
}

function normalizeSrtTime(time: string) {
  return time.replace('.', ',');
}

export function formatSrtContent(subtitles: [string, string, string][]) {
  return subtitles
    .map((subtitle, index) => {
      const [startTime, endTime, text] = subtitle;
      // SRT格式：序号 + 时间码 + 文本 + 空行
      return `${index + 1}\n${normalizeSrtTime(startTime)} --> ${normalizeSrtTime(endTime)}\n${text.trim()}\n`;
    })
    .join('\n');
}

/**
 * 创建或清空文件
 */
export async function createOrClearFile(filePath: string): Promise<void> {
  try {
    await fs.promises.writeFile(filePath, '');
  } catch (error) {
    logMessage(`Failed to create/clear file: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * 向文件追加内容
 */
export async function appendToFile(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await fs.promises.appendFile(filePath, content);
  } catch (error) {
    logMessage(`Failed to append to file: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * 读取文件内容并按行分割
 */
export async function readFileContent(filePath: string): Promise<string[]> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return content.split('\n');
  } catch (error) {
    logMessage(`Failed to read file: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * 封装文件对象
 */
export function wrapFileObject(filePath: string) {
  let fileSize = 0;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch {
    // 文件不可读时大小留 0，渲染层不展示
  }
  return {
    filePath,
    fileName: path.basename(filePath, path.extname(filePath)),
    fileNameWithoutExtension: path.basename(filePath),
    fileExtension: path.extname(filePath),
    directory: path.dirname(filePath),
    fileSize,
    uuid: Math.random().toString(36).substring(2),
  };
}
