import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { logMessage } from './storeManager';

/**
 * 构建信息接口
 */
export interface BuildInfo {
  platform: string;
  arch: string;
  buildDate: string | null;
  version?: string;
}

/**
 * 获取构建信息
 * 从package.json中读取构建时写入的平台和架构信息
 *
 * 注意：CUDA 加速包已改为运行时动态下载，不再在构建时绑定
 * CUDA 相关信息请使用 addonManager 模块获取
 */
export function getBuildInfo(): BuildInfo {
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
