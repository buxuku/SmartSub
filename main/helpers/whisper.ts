import { spawn } from 'child_process';
import { app } from 'electron';
import path from 'path';
import { isAppleSilicon, isWin32, getExtraResourcesPath } from './utils';
import { BrowserWindow, DownloadItem } from 'electron';
import decompress from 'decompress';
import fs from 'fs-extra';
import { store, logMessage } from './storeManager';
import { getEffectivePlatform, isPlatformCudaCapable } from './cudaUtils';
import {
  getSelectedAddonVersion,
  getAddonVersionDir,
  hasDependentLibs,
  isAddonInstalled,
} from './addonManager';

export const getPath = (key?: string) => {
  const userDataPath = app.getPath('userData');
  const settings = store.get('settings') || {
    modelsPath: path.join(userDataPath, 'whisper-models'),
  };
  // 使用用户自定义的模型路径或默认路径
  const modelsPath =
    settings.modelsPath || path.join(userDataPath, 'whisper-models');
  if (!fs.existsSync(modelsPath)) {
    fs.mkdirSync(modelsPath, { recursive: true });
  }
  const res = {
    userDataPath,
    modelsPath,
  };
  if (key) return res[key];
  return res;
};

export const getModelsInstalled = () => {
  const modelsPath = getPath('modelsPath');
  try {
    const models = fs
      .readdirSync(modelsPath)
      ?.filter((file) => file.startsWith('ggml-') && file.endsWith('.bin'));
    return models.map((model) =>
      model.replace('ggml-', '').replace('.bin', ''),
    );
  } catch (e) {
    return [];
  }
};

export const deleteModel = async (model) => {
  const modelsPath = getPath('modelsPath');
  const modelPath = path.join(modelsPath, `ggml-${model}.bin`);
  const coreMLModelPath = path.join(
    modelsPath,
    `ggml-${model}-encoder.mlmodelc`,
  );

  return new Promise((resolve, reject) => {
    try {
      if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
      }
      if (fs.existsSync(coreMLModelPath)) {
        fs.removeSync(coreMLModelPath); // 递归删除目录
      }
      resolve('ok');
    } catch (error) {
      console.error('删除模型失败:', error);
      reject(error);
    }
  });
};

export const downloadModelSync = async (
  model: string,
  source: string,
  onProcess: (progress: number, message: string) => void,
  needsCoreML = true,
) => {
  const modelsPath = getPath('modelsPath');
  const modelPath = path.join(modelsPath, `ggml-${model}.bin`);
  const coreMLModelPath = path.join(
    modelsPath,
    `ggml-${model}-encoder.mlmodelc`,
  );

  // 检查模型文件是否已存在
  if (fs.existsSync(modelPath)) {
    // 如果不需要CoreML支持，或者不是Apple Silicon，或者CoreML文件已存在，则直接返回
    if (!needsCoreML || !isAppleSilicon() || fs.existsSync(coreMLModelPath)) {
      return;
    }
  }

  const baseUrl = `https://${
    source === 'huggingface' ? 'huggingface.co' : 'hf-mirror.com'
  }/ggerganov/whisper.cpp/resolve/main`;
  const url = `${baseUrl}/ggml-${model}.bin`;

  // 只有在需要CoreML支持且是Apple Silicon时才下载CoreML模型
  const needDownloadCoreML = needsCoreML && isAppleSilicon();
  const coreMLUrl = needDownloadCoreML
    ? `${baseUrl}/ggml-${model}-encoder.mlmodelc.zip`
    : '';

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false });
    let downloadCount = 0;
    const totalDownloads = needDownloadCoreML ? 2 : 1;
    let totalBytes = { normal: 0, coreML: 0 };
    let receivedBytes = { normal: 0, coreML: 0 };

    const willDownloadHandler = (event, item: DownloadItem) => {
      const isCoreML = item.getFilename().includes('-encoder.mlmodelc');

      // 检查是否为当前模型的下载项
      if (!item.getFilename().includes(`ggml-${model}`)) {
        return; // 忽略不匹配的下载项
      }

      // 如果是CoreML文件但不需要下载CoreML，则取消下载
      if (isCoreML && !needDownloadCoreML) {
        item.cancel();
        return;
      }

      const savePath = isCoreML
        ? path.join(modelsPath, `ggml-${model}-encoder.mlmodelc.zip`)
        : modelPath;
      item.setSavePath(savePath);

      const type = isCoreML ? 'coreML' : 'normal';
      totalBytes[type] = item.getTotalBytes();

      item.on('updated', (event, state) => {
        if (state === 'progressing' && !item.isPaused()) {
          receivedBytes[type] = item.getReceivedBytes();
          const totalProgress =
            (receivedBytes.normal + receivedBytes.coreML) /
            (totalBytes.normal + totalBytes.coreML);
          const percent = totalProgress * 100;
          onProcess(totalProgress, `${percent.toFixed(2)}%`);
        }
      });

      item.once('done', async (event, state) => {
        if (state === 'completed') {
          downloadCount++;

          if (isCoreML) {
            try {
              const zipPath = path.join(
                modelsPath,
                `ggml-${model}-encoder.mlmodelc.zip`,
              );
              await decompress(zipPath, modelsPath);
              fs.unlinkSync(zipPath); // 删除zip文件
              onProcess(1, `Core ML ${model} 解压完成`);
            } catch (error) {
              console.error('解压Core ML模型失败:', error);
              reject(new Error(`解压Core ML模型失败: ${error.message}`));
            }
          }

          if (downloadCount === totalDownloads) {
            onProcess(1, `${model} 下载完成`);
            cleanup();
            resolve(1);
          }
        } else {
          cleanup();
          reject(new Error(`${model} download error: ${state}`));
        }
      });
    };

    const cleanup = () => {
      win.webContents.session.removeListener(
        'will-download',
        willDownloadHandler,
      );
      win.destroy();
    };

    win.webContents.session.on('will-download', willDownloadHandler);
    win.webContents.downloadURL(url);

    // 只有在需要时才下载CoreML模型
    if (needDownloadCoreML) {
      win.webContents.downloadURL(coreMLUrl);
    }
  });
};

export async function checkOpenAiWhisper(): Promise<boolean> {
  return new Promise((resolve) => {
    const command = isWin32() ? 'whisper.exe' : 'whisper';
    const env = { ...process.env, PYTHONIOENCODING: 'UTF-8' };
    const childProcess = spawn(command, ['-h'], { env, shell: true });

    const timeout = setTimeout(() => {
      childProcess.kill();
      resolve(false);
    }, 5000);

    childProcess.on('error', (error) => {
      clearTimeout(timeout);
      console.log('spawn error: ', error);
      resolve(false);
    });

    childProcess.on('exit', (code) => {
      clearTimeout(timeout);
      console.log('exit code: ', code);
      resolve(code === 0);
    });
  });
}

export const reinstallWhisper = async () => {
  const whisperPath = getPath('whisperPath');

  // 删除现有的 whisper.cpp 目录
  try {
    await fs.remove(whisperPath);
    return true;
  } catch (error) {
    console.error('删除 whisper.cpp 目录失败:', error);
    throw new Error('删除 whisper.cpp 目录失败');
  }
};

// 判断模型是否是量化模型
export const isQuantizedModel = (model) => {
  return model.includes('-q5_') || model.includes('-q8_');
};

// 判断 encoder 模型是否存在
export const hasEncoderModel = (model) => {
  const encoderModelPath = path.join(
    getPath('modelsPath'),
    `ggml-${model}-encoder.mlmodelc`,
  );
  return fs.existsSync(encoderModelPath);
};

/**
 * 设置动态链接库搜索路径
 * 必须在 dlopen 之前调用
 */
function setupLibraryPath(addonDir: string): void {
  const platform = getEffectivePlatform();
  const absoluteAddonDir = path.resolve(addonDir);

  if (platform === 'win32') {
    // Windows: 将 addon 目录添加到 PATH 前面（优先级最高）
    const currentPath = process.env.PATH || '';
    if (!currentPath.includes(absoluteAddonDir)) {
      process.env.PATH = `${absoluteAddonDir};${currentPath}`;
      logMessage(`Added ${absoluteAddonDir} to PATH for DLL loading`, 'info');
    }
  } else if (platform === 'linux') {
    // Linux: 将 addon 目录添加到 LD_LIBRARY_PATH 前面
    const currentLdPath = process.env.LD_LIBRARY_PATH || '';
    if (!currentLdPath.includes(absoluteAddonDir)) {
      process.env.LD_LIBRARY_PATH = `${absoluteAddonDir}:${currentLdPath}`;
      logMessage(
        `Added ${absoluteAddonDir} to LD_LIBRARY_PATH for SO loading`,
        'info',
      );
    }
  }
}

/**
 * 加载适合当前系统的Whisper Addon
 *
 * 加载优先级：
 * 1. 如果启用 CUDA 且已安装加速包，从用户数据目录加载
 * 2. 否则从 extraResources 加载默认版本
 */
export async function loadWhisperAddon(model: string) {
  const platform = getEffectivePlatform();
  const settings = store.get('settings') || { useCuda: false };
  const useCuda = settings.useCuda || false;

  let addonPath: string;

  // 检查是否是可能支持 CUDA 的平台
  if (isPlatformCudaCapable() && useCuda) {
    // 获取用户选择的加速包版本
    const selectedVersion = getSelectedAddonVersion();

    if (selectedVersion && isAddonInstalled(selectedVersion)) {
      // 从用户数据目录加载
      const versionDir = getAddonVersionDir(selectedVersion);
      const userAddonPath = path.join(versionDir, 'addon.node');

      if (fs.existsSync(userAddonPath)) {
        // 检查并设置依赖库路径（必须在 dlopen 之前）
        if (hasDependentLibs(versionDir)) {
          setupLibraryPath(versionDir);
        }

        addonPath = userAddonPath;
        logMessage(`Loading CUDA addon from userData: ${addonPath}`, 'info');
      } else {
        // 用户数据目录的 addon 不存在，回退到默认版本
        logMessage(
          `Selected addon version ${selectedVersion} not found, falling back to default`,
          'warning',
        );
        addonPath = path.join(getExtraResourcesPath(), 'addons', 'addon.node');
      }
    } else {
      // 没有安装加速包，使用默认的 no-cuda 版本
      addonPath = path.join(getExtraResourcesPath(), 'addons', 'addon.node');
      logMessage('No CUDA addon installed, using default addon', 'info');
    }
  } else if (
    platform === 'darwin' &&
    isAppleSilicon() &&
    hasEncoderModel(model)
  ) {
    // macOS Apple Silicon with CoreML
    addonPath = path.join(
      getExtraResourcesPath(),
      'addons',
      'addon.coreml.node',
    );
    logMessage('Loading CoreML addon for Apple Silicon', 'info');
  } else {
    // 默认：从 extraResources 加载
    addonPath = path.join(getExtraResourcesPath(), 'addons', 'addon.node');
    logMessage('Loading default addon from extraResources', 'info');
  }

  if (!addonPath) {
    throw new Error('Unsupported platform or architecture');
  }

  if (!fs.existsSync(addonPath)) {
    throw new Error(`Addon not found: ${addonPath}`);
  }

  logMessage(`Loading whisper addon from: ${addonPath}`, 'info');

  const module = { exports: { whisper: null } };
  process.dlopen(module, addonPath);

  return module.exports.whisper as (
    params: Record<string, unknown>,
    callback: (error: Error | null, result?: unknown) => void,
  ) => void;
}
