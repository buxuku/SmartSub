import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { logMessage } from './storeManager';

/**
 * 获取构建信息
 * 从package.json中读取构建时写入的平台、架构和CUDA版本信息
 */
export function getBuildInfo() {
  try {
    // 在生产环境中，package.json位于应用程序资源目录
    const packagePath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'package.json')
      : path.join(app.getAppPath(), 'package.json');

    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    // 返回构建信息，如果不存在则返回基本信息
    return (
      packageJson.buildInfo || {
        platform: process.platform,
        arch: process.arch,
        version: app.getVersion(),
        buildDate: null,
      }
    );
  } catch (error) {
    logMessage(`Error reading build info: ${error}`, 'error');
    return {
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      buildDate: null,
    };
  }
}

/**
 * 获取当前应用的CUDA版本信息
 * 仅在Windows平台且有CUDA支持时返回版本信息
 */
export function getCudaVersionInfo() {
  const buildInfo = getBuildInfo();

  if (buildInfo.platform === 'win32' && buildInfo.cudaVersion) {
    return {
      version: buildInfo.cudaVersion,
      optimization: buildInfo.cudaOpt || 'generic',
    };
  }

  return null;
}
