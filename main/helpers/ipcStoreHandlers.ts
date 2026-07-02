import { app, ipcMain } from 'electron';
import os from 'os';
import { store } from './store';
import { defaultUserConfig } from './utils';
import { inferDisplayOutcome } from './engines/outcomePresets';
import { getAndInitializeProviders } from './providerManager';
import { getAsrProviders, setAsrProviders } from './asrProviderManager';
import { testAsrConnection } from '../service/asr/testConnection';
import { logMessage } from './logger';
import { LogEntry } from './store/types';
import { getBuildInfo } from './buildInfo';
import { exportConfig, importConfig } from './configExporter';
import { rebuildAppMenu } from './menu';
import { shutdownPythonRuntime } from './pythonRuntime';
import { applyProxyFromSettings } from './network/proxyManager';
import { syncTaskPowerSaveBlocker } from './powerSaveManager';

console.log(app.getVersion(), 'version');

export function setupStoreHandlers() {
  // gpuMode 一次性迁移：
  // 老用户（settings 中无 gpuMode）统一迁移为 'auto'，并标记待通知；
  // 新装用户由 store defaults 提供 gpuMode='auto'，不会进入此分支。
  const currentSettings = store.get('settings');
  if (currentSettings && currentSettings.gpuMode === undefined) {
    store.set('settings', {
      ...currentSettings,
      gpuMode: 'auto',
      gpuMigrationNotified: false,
    });
    logMessage(
      `Migrated GPU settings: useCuda=${currentSettings.useCuda} -> gpuMode=auto`,
      'info',
    );
  }

  // 启动时初始化服务商配置
  getAndInitializeProviders().then(async () => {
    const osInfo = {
      platform: os.platform(),
      arch: os.arch(),
      version: os.version(),
      model: os.machine(),
      cpuModel: os?.cpus()?.[0]?.model,
      release: os.release(),
      totalmem: os.totalmem(),
      freemem: os.freemem(),
      type: os.type(),
      buildInfo: getBuildInfo(),
    };
    logMessage(`osInfo: ${JSON.stringify(osInfo, null, 2)}`, 'info');
    logMessage('Translation providers initialized', 'info');
  });

  // Provider 相关处理
  ipcMain.on('setTranslationProviders', async (event, providers) => {
    store.set('translationProviders', providers);
  });

  ipcMain.handle('getTranslationProviders', async () => {
    return getAndInitializeProviders();
  });

  // 云端听写（在线 ASR）服务商实例：多实例、含凭据，无自动初始化（缺省空列表）。
  ipcMain.on('setAsrProviders', async (event, providers) => {
    setAsrProviders(providers);
  });

  ipcMain.handle('getAsrProviders', async () => {
    return getAsrProviders();
  });

  // 云 ASR 实例连通性自测：跑在主进程规避渲染进程 CORS（对齐 testTranslation）。
  ipcMain.handle('testAsrProvider', async (_event, provider) => {
    return testAsrConnection(provider);
  });

  // 用户配置相关处理
  ipcMain.on('setUserConfig', async (event, config) => {
    store.set('userConfig', config);
  });

  ipcMain.handle('getUserConfig', async () => {
    const storedConfig = store.get('userConfig');
    const merged: Record<string, unknown> = {
      ...defaultUserConfig,
      ...storedConfig,
    };
    // 字幕效果默认档：缺省时按既有旋钮惰性推断（全新/默认→均衡；老用户自定义→对应档或
    // custom，逐字保留行为）。在此补齐而非写 store 默认值，避免回灌覆盖老用户底层旋钮。
    if (merged.subtitleOutcome === undefined) {
      merged.subtitleOutcome = inferDisplayOutcome(
        merged,
        store.get('settings') as Record<string, unknown>,
      );
    }
    return merged;
  });

  // 设置相关处理
  ipcMain.handle('setSettings', async (event, settings) => {
    const preSettings = store.get('settings');
    store.set('settings', { ...preSettings, ...settings });
    if (
      settings?.proxyMode !== undefined ||
      settings?.proxyUrl !== undefined ||
      settings?.proxyNoProxy !== undefined
    ) {
      applyProxyFromSettings();
    }
    if (settings?.preventSleepDuringTask !== undefined) {
      syncTaskPowerSaveBlocker();
    }
    if (
      settings?.fasterWhisperModelsPath &&
      settings.fasterWhisperModelsPath !== preSettings?.fasterWhisperModelsPath
    ) {
      await shutdownPythonRuntime();
      logMessage(
        `faster-whisper models path changed, python engine restarted`,
        'info',
      );
    }
    // 语言切换后重建应用菜单
    if (settings?.language && settings.language !== preSettings?.language) {
      rebuildAppMenu(settings.language);
    }
  });

  ipcMain.handle('getSettings', async () => {
    return store.get('settings');
  });

  // 日志相关处理
  ipcMain.handle(
    'addLog',
    async (event, logEntry: Omit<LogEntry, 'timestamp'>) => {
      const logs = store.get('logs');
      const newLog = {
        ...logEntry,
        timestamp: Date.now(),
      };
      store.set('logs', [...logs, newLog]);
      event.sender.send('newLog', newLog);
    },
  );

  ipcMain.handle('getLogs', async (event, projectId?: string) => {
    const logs = store.get('logs') || [];
    if (!projectId) return logs;
    return logs.filter((log) => log.projectId === projectId);
  });

  ipcMain.handle('clearLogs', async (_event, projectId?: string) => {
    const logs = store.get('logs') || [];
    if (!projectId) {
      store.set('logs', []);
      return true;
    }
    store.set(
      'logs',
      logs.filter((log) => log.projectId !== projectId),
    );
    return true;
  });

  // 清理配置
  ipcMain.handle('clearConfig', async () => {
    store.clear();
    return true;
  });

  // 配置导入导出
  ipcMain.handle('exportConfig', async (_event, password: string) => {
    return exportConfig(password);
  });

  ipcMain.handle('importConfig', async (_event, password: string) => {
    return importConfig(password);
  });
}
