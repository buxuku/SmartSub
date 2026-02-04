import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logMessage } from './storeManager';
import type {
  AddonConfig,
  InstalledAddon,
  CudaVersion,
} from '../../types/addon';
import { AVAILABLE_CUDA_VERSIONS } from '../../types/addon';
import { getEffectivePlatform } from './cudaUtils';

/**
 * 获取 addons 目录路径
 */
export function getAddonsDir(): string {
  return path.join(app.getPath('userData'), 'addons');
}

/**
 * 获取配置文件路径
 */
function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'addon-config.json');
}

/**
 * 读取加速包配置
 */
export function getAddonConfig(): AddonConfig {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    logMessage(`Error reading addon config: ${error}`, 'error');
  }

  return {
    selectedVersion: null,
    installed: {},
  };
}

/**
 * 保存加速包配置
 */
export function saveAddonConfig(config: AddonConfig): void {
  try {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    logMessage('Addon config saved', 'info');
  } catch (error) {
    logMessage(`Error saving addon config: ${error}`, 'error');
  }
}

/**
 * 获取特定版本的 addon 目录路径
 */
export function getAddonVersionDir(version: CudaVersion): string {
  const versionNum = version.replace(/\./g, '');
  return path.join(getAddonsDir(), `cuda-${versionNum}`);
}

/**
 * 检查特定版本的 addon 是否已安装
 */
export function isAddonInstalled(version: CudaVersion): boolean {
  const versionDir = getAddonVersionDir(version);
  const addonPath = path.join(versionDir, 'addon.node');
  return fs.existsSync(addonPath);
}

/**
 * 检查目录下是否有依赖的动态链接库
 */
export function hasDependentLibs(versionDir: string): boolean {
  const platform = getEffectivePlatform();

  try {
    const files = fs.readdirSync(versionDir);

    if (platform === 'win32') {
      return files.some((f) => f.toLowerCase().endsWith('.dll'));
    } else if (platform === 'linux') {
      return files.some((f) => f.includes('.so'));
    }
  } catch {
    // 目录不存在或无法读取
  }

  return false;
}

/**
 * 获取已安装的加速包列表
 */
export function getInstalledAddons(): Array<{
  version: CudaVersion;
  info: InstalledAddon;
}> {
  const config = getAddonConfig();
  const result: Array<{ version: CudaVersion; info: InstalledAddon }> = [];

  // 遍历所有可用版本
  for (const version of AVAILABLE_CUDA_VERSIONS) {
    if (isAddonInstalled(version)) {
      const info = config.installed[version] || {
        installedAt: new Date().toISOString(),
        remoteVersion: 'unknown',
        hasDlls: hasDependentLibs(getAddonVersionDir(version)),
        size: getAddonSize(version),
      };
      result.push({ version, info });
    }
  }

  return result;
}

/**
 * 获取 addon 大小
 */
function getAddonSize(version: CudaVersion): number {
  const versionDir = getAddonVersionDir(version);
  let totalSize = 0;

  try {
    const files = fs.readdirSync(versionDir);
    for (const file of files) {
      const filePath = path.join(versionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        totalSize += stat.size;
      }
    }
  } catch {
    // 忽略错误
  }

  return totalSize;
}

/**
 * 注册已安装的加速包
 */
export function registerInstalledAddon(
  version: CudaVersion,
  remoteVersion: string,
  checksum?: string,
): void {
  const config = getAddonConfig();
  const versionDir = getAddonVersionDir(version);

  config.installed[version] = {
    installedAt: new Date().toISOString(),
    remoteVersion,
    hasDlls: hasDependentLibs(versionDir),
    size: getAddonSize(version),
    checksum,
  };

  // 如果没有选中版本，自动选中新安装的
  if (!config.selectedVersion) {
    config.selectedVersion = version;
  }

  saveAddonConfig(config);
}

/**
 * 选择加速包版本
 */
export function selectAddonVersion(version: CudaVersion | null): void {
  const config = getAddonConfig();

  // 如果指定了版本，检查是否已安装
  if (version && !isAddonInstalled(version)) {
    throw new Error(`Addon version ${version} is not installed`);
  }

  config.selectedVersion = version;
  saveAddonConfig(config);
  logMessage(`Selected addon version: ${version}`, 'info');
}

/**
 * 获取当前选中的加速包版本
 */
export function getSelectedAddonVersion(): CudaVersion | null {
  const config = getAddonConfig();

  // 验证选中的版本是否仍然存在
  if (config.selectedVersion && !isAddonInstalled(config.selectedVersion)) {
    // 版本不存在，清除选择
    config.selectedVersion = null;
    saveAddonConfig(config);
  }

  return config.selectedVersion;
}

/**
 * 获取 addon.node 文件路径
 */
export function getAddonPath(version: CudaVersion): string | null {
  const versionDir = getAddonVersionDir(version);
  const addonPath = path.join(versionDir, 'addon.node');

  if (fs.existsSync(addonPath)) {
    return addonPath;
  }

  return null;
}

/**
 * 删除加速包
 */
export async function removeAddon(version: CudaVersion): Promise<void> {
  const config = getAddonConfig();
  const versionDir = getAddonVersionDir(version);

  // 检查是否是当前选中的版本
  if (config.selectedVersion === version) {
    config.selectedVersion = null;
  }

  // 从配置中移除
  delete config.installed[version];
  saveAddonConfig(config);

  // 删除文件
  if (fs.existsSync(versionDir)) {
    await fs.promises.rm(versionDir, { recursive: true, force: true });
    logMessage(`Removed addon version ${version}`, 'info');
  }
}

/**
 * 备份加速包（更新前）
 */
export async function backupAddon(
  version: CudaVersion,
): Promise<string | null> {
  const versionDir = getAddonVersionDir(version);

  if (!fs.existsSync(versionDir)) {
    return null;
  }

  const backupDir = path.join(getAddonsDir(), 'backup');
  const backupPath = path.join(
    backupDir,
    `cuda-${version.replace(/\./g, '')}_backup`,
  );

  // 确保备份目录存在
  fs.mkdirSync(backupDir, { recursive: true });

  // 删除旧备份
  if (fs.existsSync(backupPath)) {
    await fs.promises.rm(backupPath, { recursive: true, force: true });
  }

  // 复制文件
  await copyDir(versionDir, backupPath);

  logMessage(`Backed up addon ${version} to ${backupPath}`, 'info');
  return backupPath;
}

/**
 * 恢复加速包备份
 */
export async function restoreAddonBackup(
  version: CudaVersion,
): Promise<boolean> {
  const backupDir = path.join(getAddonsDir(), 'backup');
  const backupPath = path.join(
    backupDir,
    `cuda-${version.replace(/\./g, '')}_backup`,
  );
  const versionDir = getAddonVersionDir(version);

  if (!fs.existsSync(backupPath)) {
    logMessage(`No backup found for addon ${version}`, 'warning');
    return false;
  }

  // 删除当前版本
  if (fs.existsSync(versionDir)) {
    await fs.promises.rm(versionDir, { recursive: true, force: true });
  }

  // 恢复备份
  await copyDir(backupPath, versionDir);

  logMessage(`Restored addon ${version} from backup`, 'info');
  return true;
}

/**
 * 清理备份
 */
export async function cleanupBackup(version: CudaVersion): Promise<void> {
  const backupDir = path.join(getAddonsDir(), 'backup');
  const backupPath = path.join(
    backupDir,
    `cuda-${version.replace(/\./g, '')}_backup`,
  );

  if (fs.existsSync(backupPath)) {
    await fs.promises.rm(backupPath, { recursive: true, force: true });
    logMessage(`Cleaned up backup for addon ${version}`, 'info');
  }
}

/**
 * 复制目录
 */
async function copyDir(src: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });

  const entries = await fs.promises.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

/**
 * 检查是否有任何已安装的加速包
 */
export function hasAnyAddonInstalled(): boolean {
  const installed = getInstalledAddons();
  return installed.length > 0;
}

/**
 * 获取加速包摘要信息
 */
export function getAddonSummary(): {
  hasInstalled: boolean;
  selectedVersion: CudaVersion | null;
  installedCount: number;
  installedVersions: CudaVersion[];
} {
  const installed = getInstalledAddons();
  const selected = getSelectedAddonVersion();

  return {
    hasInstalled: installed.length > 0,
    selectedVersion: selected,
    installedCount: installed.length,
    installedVersions: installed.map((i) => i.version),
  };
}
