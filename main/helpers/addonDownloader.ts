import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import * as tar from 'tar';
import { logMessage } from './storeManager';
import type {
  DownloadProgress,
  DownloadState,
  DownloadSource,
  CudaVersion,
  DownloadStatus,
} from '../../types/addon';
import { getEffectivePlatform } from './cudaUtils';
import { createHash } from 'crypto';

/**
 * 下载源配置
 */
const DOWNLOAD_SOURCES: Record<DownloadSource, string> = {
  github: 'https://github.com/buxuku/whisper.cpp/releases/download/latest/',
  ghproxy:
    'https://ghfast.top/https://github.com/buxuku/whisper.cpp/releases/download/latest/',
};

/**
 * 获取下载状态文件路径
 */
function getDownloadStatePath(): string {
  return path.join(app.getPath('userData'), 'addon-download-state.json');
}

/**
 * 读取下载状态
 */
export function readDownloadState(): DownloadState | null {
  try {
    const statePath = getDownloadStatePath();
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    logMessage(`Error reading download state: ${error}`, 'error');
  }
  return null;
}

/**
 * 保存下载状态
 */
function saveDownloadState(state: DownloadState | null): void {
  try {
    const statePath = getDownloadStatePath();
    if (state === null) {
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
      }
    } else {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  } catch (error) {
    logMessage(`Error saving download state: ${error}`, 'error');
  }
}

/**
 * 获取加速包文件名
 */
export function getAddonFileName(
  cudaVersion: CudaVersion,
  downloadType: 'node.gz' | 'tar.gz',
): string {
  const platform = getEffectivePlatform();
  const versionNum = cudaVersion.replace(/\./g, '').slice(0, 4);

  if (platform === 'win32') {
    if (downloadType === 'tar.gz') {
      return `windows-cuda-${versionNum}-optimized.tar.gz`;
    } else {
      return `addon-windows-cuda-${versionNum}-optimized.node.gz`;
    }
  } else if (platform === 'linux') {
    if (downloadType === 'tar.gz') {
      return `linux-cuda-${versionNum}-optimized.tar.gz`;
    } else {
      return `addon-linux-cuda-${versionNum}-optimized.node.gz`;
    }
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * 获取完整下载 URL
 */
export function getDownloadUrl(
  source: DownloadSource,
  cudaVersion: CudaVersion,
  downloadType: 'node.gz' | 'tar.gz',
): string {
  const baseUrl = DOWNLOAD_SOURCES[source];
  const fileName = getAddonFileName(cudaVersion, downloadType);
  return `${baseUrl}${fileName}`;
}

/**
 * 加速包下载器类
 */
export class AddonDownloader {
  private abortController: AbortController | null = null;
  private currentProgress: DownloadProgress = {
    status: 'idle',
    progress: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: 0,
  };
  private mainWindow: BrowserWindow | null = null;
  private lastSpeedCalcTime: number = 0;
  private lastSpeedCalcBytes: number = 0;

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
  }

  /**
   * 设置主窗口用于发送进度事件
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * 获取当前下载进度
   */
  getProgress(): DownloadProgress {
    return { ...this.currentProgress };
  }

  /**
   * 发送进度更新到渲染进程
   */
  private sendProgress(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(
        'addon-download-progress',
        this.currentProgress,
      );
    }
  }

  /**
   * 更新进度状态
   */
  private updateProgress(update: Partial<DownloadProgress>): void {
    this.currentProgress = { ...this.currentProgress, ...update };

    // 计算下载速度
    const now = Date.now();
    if (now - this.lastSpeedCalcTime >= 1000) {
      const bytesPerSecond =
        ((this.currentProgress.downloaded - this.lastSpeedCalcBytes) * 1000) /
        (now - this.lastSpeedCalcTime);
      this.currentProgress.speed = Math.max(0, bytesPerSecond);

      // 计算预计剩余时间
      if (bytesPerSecond > 0 && this.currentProgress.total > 0) {
        const remainingBytes =
          this.currentProgress.total - this.currentProgress.downloaded;
        this.currentProgress.eta = Math.ceil(remainingBytes / bytesPerSecond);
      }

      this.lastSpeedCalcTime = now;
      this.lastSpeedCalcBytes = this.currentProgress.downloaded;
    }

    // 计算进度百分比
    if (this.currentProgress.total > 0) {
      this.currentProgress.progress =
        (this.currentProgress.downloaded / this.currentProgress.total) * 100;
    }

    this.sendProgress();
  }

  /**
   * 取消下载
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.updateProgress({ status: 'idle' });
  }

  /**
   * 执行下载
   */
  async download(
    source: DownloadSource,
    cudaVersion: CudaVersion,
    downloadType: 'node.gz' | 'tar.gz',
  ): Promise<string> {
    const url = getDownloadUrl(source, cudaVersion, downloadType);
    const addonsDir = path.join(app.getPath('userData'), 'addons');
    const versionDir = path.join(
      addonsDir,
      `cuda-${cudaVersion.replace(/\./g, '')}`,
    );

    // 确保目录存在
    fs.mkdirSync(versionDir, { recursive: true });

    // 初始化下载状态
    this.abortController = new AbortController();
    this.lastSpeedCalcTime = Date.now();
    this.lastSpeedCalcBytes = 0;

    this.updateProgress({
      status: 'downloading',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: 0,
      error: undefined,
    });

    try {
      // 检查是否有未完成的下载
      const existingState = readDownloadState();
      let startByte = 0;
      let tempPath: string;

      if (
        existingState &&
        existingState.url === url &&
        fs.existsSync(existingState.tempPath)
      ) {
        // 继续之前的下载，使用相同的 temp 文件
        tempPath = existingState.tempPath;
        const stat = fs.statSync(tempPath);
        startByte = stat.size;

        // 如果已经下载完成（文件大小等于预期大小），直接跳到解压步骤
        if (existingState.total > 0 && stat.size >= existingState.total) {
          logMessage(
            `Download already complete, skipping to extraction`,
            'info',
          );
          this.updateProgress({
            downloaded: stat.size,
            total: existingState.total,
            progress: 100,
            status: 'extracting',
          });

          // 直接解压
          await this.extractFile(tempPath, versionDir, downloadType);

          // 清理
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
          saveDownloadState(null);

          this.updateProgress({ status: 'completed', progress: 100 });
          logMessage(`Addon extracted to ${versionDir}`, 'info');

          return versionDir;
        }

        this.updateProgress({
          downloaded: startByte,
          total: existingState.total,
        });
        logMessage(`Resuming download from byte ${startByte}`, 'info');
      } else {
        // 新下载，清理旧的 temp 文件
        tempPath = path.join(
          addonsDir,
          `temp-${cudaVersion.replace(/\./g, '')}`,
        );
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
          logMessage(`Cleaned up old temp file: ${tempPath}`, 'info');
        }
      }

      // 下载文件
      const downloadedPath = await this.downloadFile(
        url,
        tempPath,
        startByte,
        cudaVersion,
        downloadType,
      );

      // 更新状态为解压中
      this.updateProgress({ status: 'extracting' });

      // 解压文件
      await this.extractFile(downloadedPath, versionDir, downloadType);

      // 清理临时文件
      if (fs.existsSync(downloadedPath)) {
        fs.unlinkSync(downloadedPath);
      }
      saveDownloadState(null);

      // 完成
      this.updateProgress({ status: 'completed', progress: 100 });
      logMessage(`Addon downloaded and extracted to ${versionDir}`, 'info');

      return versionDir;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (errorMessage === 'Download cancelled') {
        this.updateProgress({ status: 'idle', error: 'Download cancelled' });
        throw error;
      }

      this.updateProgress({ status: 'error', error: errorMessage });
      logMessage(`Download error: ${errorMessage}`, 'error');
      throw error;
    }
  }

  /**
   * 下载文件（支持断点续传）
   */
  private downloadFile(
    url: string,
    destPath: string,
    startByte: number,
    cudaVersion: CudaVersion,
    downloadType: 'node.gz' | 'tar.gz',
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const headers: Record<string, string> = {
        'User-Agent': 'SmartSub-Electron',
      };

      // 如果是续传，添加 Range 头
      if (startByte > 0) {
        headers['Range'] = `bytes=${startByte}-`;
      }

      // 无数据活动超时时间（60秒无数据则超时）
      const INACTIVITY_TIMEOUT = 60000;
      let inactivityTimer: NodeJS.Timeout | null = null;
      let isCompleted = false;

      const resetInactivityTimer = () => {
        if (inactivityTimer) {
          clearTimeout(inactivityTimer);
        }
        if (!isCompleted) {
          inactivityTimer = setTimeout(() => {
            if (!isCompleted) {
              request.destroy();
              reject(
                new Error('Download timeout: no data received for 60 seconds'),
              );
            }
          }, INACTIVITY_TIMEOUT);
        }
      };

      const clearInactivityTimer = () => {
        if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = null;
        }
      };

      const request = protocol.get(url, { headers }, (response) => {
        // 处理重定向
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400
        ) {
          clearInactivityTimer();
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFile(
              redirectUrl,
              destPath,
              startByte,
              cudaVersion,
              downloadType,
            )
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        // 检查响应状态
        if (response.statusCode && response.statusCode >= 400) {
          clearInactivityTimer();
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }

        // 获取文件总大小
        let totalSize = 0;
        if (response.statusCode === 206) {
          // 部分内容响应
          const contentRange = response.headers['content-range'];
          if (contentRange) {
            const match = contentRange.match(/\/(\d+)$/);
            if (match) {
              totalSize = parseInt(match[1], 10);
            }
          }
        } else {
          const contentLength = response.headers['content-length'];
          if (contentLength) {
            totalSize = parseInt(contentLength, 10) + startByte;
          }
        }

        this.updateProgress({ total: totalSize, downloaded: startByte });

        // 保存下载状态
        const state: DownloadState = {
          url,
          destPath,
          tempPath: destPath,
          downloaded: startByte,
          total: totalSize,
          cudaVersion,
          downloadType,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        };
        saveDownloadState(state);

        // 创建写入流
        const writeStream = fs.createWriteStream(destPath, {
          flags: startByte > 0 ? 'a' : 'w',
        });

        let downloadedBytes = startByte;

        // 启动无活动超时计时器
        resetInactivityTimer();

        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          this.updateProgress({ downloaded: downloadedBytes });

          // 收到数据，重置超时计时器
          resetInactivityTimer();

          // 更新持久化状态
          state.downloaded = downloadedBytes;
          state.lastUpdatedAt = new Date().toISOString();
          saveDownloadState(state);
        });

        // 响应流结束（所有数据已接收），清除超时计时器
        response.on('end', () => {
          clearInactivityTimer();
          logMessage(
            'Response stream ended, waiting for file write to complete',
            'info',
          );
        });

        response.pipe(writeStream);

        writeStream.on('finish', () => {
          isCompleted = true;
          clearInactivityTimer();
          resolve(destPath);
        });

        writeStream.on('error', (err) => {
          isCompleted = true;
          clearInactivityTimer();
          reject(err);
        });

        // 处理取消
        if (this.abortController) {
          this.abortController.signal.addEventListener('abort', () => {
            isCompleted = true;
            clearInactivityTimer();
            request.destroy();
            writeStream.close();
            reject(new Error('Download cancelled'));
          });
        }
      });

      request.on('error', (err) => {
        isCompleted = true;
        clearInactivityTimer();
        reject(err);
      });

      // 连接超时（仅用于建立连接，30秒）
      request.setTimeout(30000, () => {
        // 只有在还没有收到响应时才触发超时
        // 一旦开始接收数据，由 inactivityTimer 接管
      });

      // 启动初始超时计时器
      resetInactivityTimer();
    });
  }

  /**
   * 解压文件
   */
  private async extractFile(
    filePath: string,
    destDir: string,
    downloadType: 'node.gz' | 'tar.gz',
  ): Promise<void> {
    if (downloadType === 'tar.gz') {
      // 解压 tar.gz 文件
      await tar.extract({
        file: filePath,
        cwd: destDir,
      });

      // 重命名 .node 文件为 addon.node
      await this.renameNodeFile(destDir);
    } else {
      // 解压 .node.gz 文件
      const destPath = path.join(destDir, 'addon.node');
      await this.gunzipFile(filePath, destPath);
    }

    logMessage(`Extracted to ${destDir}`, 'info');
  }

  /**
   * 查找并重命名 .node 文件为 addon.node
   * 支持在根目录和一级子目录中查找
   */
  private async renameNodeFile(destDir: string): Promise<void> {
    // 首先在根目录查找
    const files = fs.readdirSync(destDir);
    logMessage(`Files in ${destDir}: ${files.join(', ')}`, 'info');

    let nodeFile = files.find((f) => f.endsWith('.node') && f !== 'addon.node');

    if (nodeFile) {
      const oldPath = path.join(destDir, nodeFile);
      const newPath = path.join(destDir, 'addon.node');

      // 如果已存在 addon.node，先删除
      if (fs.existsSync(newPath)) {
        fs.unlinkSync(newPath);
      }

      fs.renameSync(oldPath, newPath);
      logMessage(`Renamed ${nodeFile} to addon.node`, 'info');
      return;
    }

    // 如果根目录没找到，检查一级子目录（tar 可能解压到子目录）
    for (const item of files) {
      const itemPath = path.join(destDir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        const subFiles = fs.readdirSync(itemPath);
        logMessage(
          `Files in subdirectory ${item}: ${subFiles.join(', ')}`,
          'info',
        );

        // 查找 .node 文件
        nodeFile = subFiles.find(
          (f) => f.endsWith('.node') && f !== 'addon.node',
        );

        if (nodeFile) {
          // 将子目录中的所有文件移动到根目录
          for (const subFile of subFiles) {
            const srcPath = path.join(itemPath, subFile);
            const destPath = path.join(
              destDir,
              subFile === nodeFile ? 'addon.node' : subFile,
            );

            // 如果目标文件已存在，先删除
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath);
            }

            fs.renameSync(srcPath, destPath);
            logMessage(
              `Moved ${subFile} from subdirectory to ${destPath}`,
              'info',
            );
          }

          // 删除空的子目录
          fs.rmdirSync(itemPath);
          logMessage(`Removed empty subdirectory: ${item}`, 'info');
          return;
        }
      }
    }

    // 检查是否已经有 addon.node 文件
    if (files.includes('addon.node')) {
      logMessage('addon.node already exists', 'info');
      return;
    }

    logMessage('No .node file found in extracted contents', 'warning');
  }

  /**
   * 解压 gzip 文件
   */
  private gunzipFile(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(srcPath);
      const writeStream = fs.createWriteStream(destPath);
      const gunzip = zlib.createGunzip();

      readStream
        .pipe(gunzip)
        .pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });
  }
}

/**
 * 计算文件的 SHA256 校验和
 */
export async function calculateFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 验证文件校验和
 */
export async function verifyChecksum(
  filePath: string,
  expectedChecksum: string,
): Promise<boolean> {
  try {
    const actualChecksum = await calculateFileChecksum(filePath);
    return actualChecksum.toLowerCase() === expectedChecksum.toLowerCase();
  } catch {
    return false;
  }
}

// 导出单例实例
let downloaderInstance: AddonDownloader | null = null;

export function getAddonDownloader(
  mainWindow?: BrowserWindow,
): AddonDownloader {
  if (!downloaderInstance) {
    downloaderInstance = new AddonDownloader(mainWindow);
  } else if (mainWindow) {
    downloaderInstance.setMainWindow(mainWindow);
  }
  return downloaderInstance;
}
