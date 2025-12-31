import { spawn } from 'child_process';
import { app } from 'electron';
import path from 'path';
import { isAppleSilicon, isWin32, getExtraResourcesPath } from './utils';
import { BrowserWindow, DownloadItem } from 'electron';
import decompress from 'decompress';
import fs from 'fs-extra';
import { store } from './storeManager';
import { checkCudaSupport } from './cudaUtils';

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
 * 加载适合当前系统的Whisper Addon
 */
export async function loadWhisperAddon(model) {
  const platform = process.platform;
  const settings = store.get('settings') || { useCuda: false };
  const useCuda = settings.useCuda || false;

  let addonPath;

  if ((platform === 'win32' || platform === 'linux') && useCuda) {
    // 检查 CUDA 支持
    const hasCudaSupport = await checkCudaSupport();

    if (hasCudaSupport) {
      addonPath = path.join(getExtraResourcesPath(), 'addons', 'addon.node');
    } else {
      // 如果不支持 CUDA，使用 no-cuda 版本
      addonPath = path.join(
        getExtraResourcesPath(),
        'addons',
        'addon-no-cuda.node',
      );
    }
  } else if (isAppleSilicon() && hasEncoderModel(model)) {
    addonPath = path.join(
      getExtraResourcesPath(),
      'addons',
      'addon.coreml.node',
    );
  } else {
    addonPath = path.join(getExtraResourcesPath(), 'addons', 'addon.node');
  }

  if (!addonPath) {
    throw new Error('Unsupported platform or architecture');
  }

  const module = { exports: { whisper: null } };
  process.dlopen(module, addonPath);
  return module.exports.whisper as (
    params: any,
    callback: (error: Error | null, result?: any) => void,
  ) => void;
}
