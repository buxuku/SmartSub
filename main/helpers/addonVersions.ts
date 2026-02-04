import * as https from 'https';
import * as http from 'http';
import { logMessage } from './storeManager';
import type {
  RemoteAddonVersions,
  CudaVersion,
  AddonUpdateInfo,
} from '../../types/addon';
import { getAddonConfig, getInstalledAddons } from './addonManager';

/**
 * 远程版本文件 URL
 */
const VERSIONS_URL =
  'https://github.com/buxuku/whisper.cpp/releases/download/latest/addon-versions.json';
const VERSIONS_URL_PROXY =
  'https://ghfast.top/https://github.com/buxuku/whisper.cpp/releases/download/latest/addon-versions.json';

/**
 * 缓存的远程版本信息
 */
let cachedVersions: RemoteAddonVersions | null = null;
let lastFetchTime: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

/**
 * 获取远程版本信息
 */
export async function fetchRemoteVersions(
  useProxy: boolean = false,
): Promise<RemoteAddonVersions | null> {
  // 检查缓存
  if (cachedVersions && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedVersions;
  }

  const url = useProxy ? VERSIONS_URL_PROXY : VERSIONS_URL;

  try {
    const content = await fetchJson(url);
    cachedVersions = content as RemoteAddonVersions;
    lastFetchTime = Date.now();
    logMessage('Fetched remote addon versions', 'info');
    return cachedVersions;
  } catch (error) {
    logMessage(`Error fetching remote versions: ${error}`, 'error');

    // 如果直连失败，尝试代理
    if (!useProxy) {
      logMessage('Trying proxy for remote versions...', 'info');
      return fetchRemoteVersions(true);
    }

    return null;
  }
}

/**
 * 获取 JSON 数据
 */
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const request = protocol.get(
      url,
      {
        headers: {
          'User-Agent': 'SmartSub-Electron',
          Accept: 'application/json',
        },
        timeout: 10000,
      },
      (response) => {
        // 处理重定向
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400
        ) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            fetchJson(redirectUrl).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP Error: ${response.statusCode}`));
          return;
        }

        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      },
    );

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * 检查是否强制显示更新（开发模式）
 */
function shouldForceUpdate(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return process.env.DEV_FORCE_ADDON_UPDATE === 'true';
}

/**
 * 检查指定版本是否有更新
 */
export async function checkVersionUpdate(
  version: CudaVersion,
): Promise<AddonUpdateInfo | null> {
  const config = getAddonConfig();
  const installedInfo = config.installed[version];

  if (!installedInfo) {
    return null;
  }

  // 开发模式下强制显示更新
  if (shouldForceUpdate()) {
    logMessage(`[DEV] Forcing update for version ${version}`, 'info');
    return {
      cudaVersion: version,
      hasUpdate: true,
      localVersion: installedInfo.remoteVersion,
      remoteVersion: 'dev-force-update',
      updateNotes: '开发模式强制更新测试',
    };
  }

  const remoteVersions = await fetchRemoteVersions();
  if (!remoteVersions || !remoteVersions[version]) {
    return null;
  }

  const remoteInfo = remoteVersions[version];
  const hasUpdate = remoteInfo.version > installedInfo.remoteVersion;

  return {
    cudaVersion: version,
    hasUpdate,
    localVersion: installedInfo.remoteVersion,
    remoteVersion: remoteInfo.version,
    updateNotes: remoteInfo.updateNotes,
  };
}

/**
 * 检查所有已安装版本的更新
 */
export async function checkAllUpdates(): Promise<AddonUpdateInfo[]> {
  const installed = getInstalledAddons();
  const updates: AddonUpdateInfo[] = [];

  for (const { version } of installed) {
    const updateInfo = await checkVersionUpdate(version);
    if (updateInfo) {
      updates.push(updateInfo);
    }
  }

  return updates;
}

/**
 * 获取有更新的版本列表
 */
export async function getAvailableUpdates(): Promise<AddonUpdateInfo[]> {
  const allUpdates = await checkAllUpdates();
  return allUpdates.filter((u) => u.hasUpdate);
}

/**
 * 获取特定版本的远程信息
 */
export async function getRemoteVersionInfo(
  version: CudaVersion,
): Promise<{ version: string; updateNotes: string } | null> {
  const remoteVersions = await fetchRemoteVersions();
  if (!remoteVersions || !remoteVersions[version]) {
    return null;
  }

  const info = remoteVersions[version];
  return {
    version: info.version,
    updateNotes: info.updateNotes,
  };
}

/**
 * 获取指定版本的校验和信息
 */
export async function getVersionChecksum(
  version: CudaVersion,
  type: 'windows-tar' | 'windows-node' | 'linux-tar' | 'linux-node',
): Promise<string | null> {
  const remoteVersions = await fetchRemoteVersions();
  if (!remoteVersions || !remoteVersions[version]) {
    return null;
  }

  const info = remoteVersions[version];
  return info.checksum?.[type] || null;
}

/**
 * 清除版本缓存
 */
export function clearVersionCache(): void {
  cachedVersions = null;
  lastFetchTime = 0;
}
