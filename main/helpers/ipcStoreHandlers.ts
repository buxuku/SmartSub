import { app, ipcMain } from 'electron';
import os from 'os';
import { store } from './store';
import { defaultUserConfig } from './utils';
import { inferDisplayOutcome } from './engines/outcomePresets';
import { getAndInitializeProviders } from './providerManager';
import { getAsrProviders, setAsrProviders } from './asrProviderManager';
import { testAsrConnection } from '../service/asr/testConnection';
import { getTtsProviders, setTtsProviders } from './ttsProviderManager';
import { testTtsConnection } from '../service/tts/testConnection';
import { listElevenLabsVoices } from '../service/tts/elevenlabs';
import { listAzureVoices } from '../service/tts/azure';
import { TTS_AZURE_SPEECH, TTS_ELEVENLABS } from '../../types/ttsProvider';
import { logMessage } from './logger';
import { LogEntry } from './store/types';
import {
  appendLog,
  queryLogs,
  listLogDates,
  clearLogs,
  LogQuery,
} from './logStorage';
import { getBuildInfo } from './buildInfo';
import { exportConfig, importConfig } from './configExporter';
import { rebuildAppMenu } from './menu';
import { shutdownPythonRuntime } from './pythonRuntime';
import { applyProxyFromSettings } from './network/proxyManager';
import { syncTaskPowerSaveBlocker } from './powerSaveManager';
import {
  isFactoryDefaultGgmlPath,
  resolveModelRoot,
  sanitizeStoragePathPatch,
} from './storagePaths';

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

  // modelsPath 归一化（unified-storage-root, design D4-2）：
  // 该键曾写在 store defaults 里，绝对默认路径会随任意一次 setSettings 被动持久化，
  // 与「用户主动自定义」不可区分，导致 whisper.cpp 永远不跟随统一存储目录。
  // 等于出厂默认（userData/whisper-models）即删除该键，恢复「未覆盖」语义。
  const settingsForNormalize = store.get('settings');
  if (
    settingsForNormalize &&
    isFactoryDefaultGgmlPath(
      settingsForNormalize.modelsPath,
      app.getPath('userData'),
    )
  ) {
    const { modelsPath: _factoryDefault, ...normalized } = settingsForNormalize;
    store.set('settings', normalized);
    logMessage(
      'Normalized legacy default modelsPath; ggml models now follow storageRoot/default chain',
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

  // 云端配音（TTS）服务商实例：语义对齐 asrProviders。
  ipcMain.on('setTtsProviders', async (event, providers) => {
    setTtsProviders(providers);
  });

  ipcMain.handle('getTtsProviders', async () => {
    return getTtsProviders();
  });

  // 云 TTS 实例连通性自测：真实合成一句短文本（无零成本探针）。
  ipcMain.handle('testTtsProvider', async (_event, provider) => {
    return testTtsConnection(provider);
  });

  // 在线拉取音色清单（voiceListMode 类型：ElevenLabs 账号音色 / Azure 区域全量）。
  ipcMain.handle('listTtsVoices', async (_event, provider) => {
    try {
      let voices: Array<{ id: string; name: string }>;
      if (provider?.type === TTS_ELEVENLABS) {
        voices = await listElevenLabsVoices(provider);
      } else if (provider?.type === TTS_AZURE_SPEECH) {
        voices = await listAzureVoices(provider);
      } else {
        return { ok: false, detail: `unsupported type: ${provider?.type}` };
      }
      return { ok: true, voices };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
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
    // 中文路径兜底（design D6-2）：渲染层选路校验是主执法，此处防旁路写入
    const { sanitized, rejectedKeys } = sanitizeStoragePathPatch(settings);
    if (rejectedKeys.length > 0) {
      logMessage(
        `Rejected storage path keys containing CJK characters: ${rejectedKeys.join(', ')}`,
        'warning',
      );
    }
    const nextSettings = { ...preSettings, ...sanitized };
    store.set('settings', nextSettings);
    if (
      sanitized?.proxyMode !== undefined ||
      sanitized?.proxyUrl !== undefined ||
      sanitized?.proxyNoProxy !== undefined
    ) {
      applyProxyFromSettings();
    }
    if (sanitized?.preventSleepDuringTask !== undefined) {
      syncTaskPowerSaveBlocker();
    }
    // Python 运行时重启判定（design D7）：比较 CT2「有效根目录」写入前后变化，
    // 覆盖改单独覆盖、设置/清除统一目录、清空覆盖恢复跟随三类场景。
    const userDataPath = app.getPath('userData');
    const preCt2Root = resolveModelRoot('ct2', preSettings, userDataPath).path;
    const nextCt2Root = resolveModelRoot(
      'ct2',
      nextSettings,
      userDataPath,
    ).path;
    if (preCt2Root !== nextCt2Root) {
      await shutdownPythonRuntime();
      logMessage(
        `faster-whisper effective models path changed (${preCt2Root} -> ${nextCt2Root}), python engine restarted`,
        'info',
      );
    }
    // 语言切换后重建应用菜单
    if (
      typeof sanitized?.language === 'string' &&
      sanitized.language !== preSettings?.language
    ) {
      rebuildAppMenu(sanitized.language);
    }
    return { rejectedKeys };
  });

  ipcMain.handle('getSettings', async () => {
    return store.get('settings');
  });

  // 日志相关处理（按日 JSONL 文件存储，见 logStorage.ts）
  ipcMain.handle(
    'addLog',
    async (event, logEntry: Omit<LogEntry, 'timestamp'>) => {
      const newLog: LogEntry = {
        ...logEntry,
        timestamp: Date.now(),
      };
      appendLog(newLog);
      event.sender.send('newLog', newLog);
    },
  );

  ipcMain.handle('getLogs', async (_event, query?: LogQuery) => {
    return queryLogs(query || {});
  });

  ipcMain.handle('getLogDates', async () => {
    return listLogDates();
  });

  ipcMain.handle('clearLogs', async (_event, projectId?: string) => {
    await clearLogs(projectId);
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
