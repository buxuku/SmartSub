// 必须是第一个 import：放大 libuv 线程池（首个异步 I/O 后定型，不可再改）
import './helpers/uvThreadPool';

// 在最开始加载环境变量（仅开发模式；路径相对 app/ 编译产物）
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({
    path: require('path').join(__dirname, '../../.env.development.local'),
  });
}

import path from 'path';
import { app, protocol } from 'electron';
import serve from 'electron-serve';
import { createWindow } from './helpers/create-window';
import { setupIpcHandlers } from './helpers/ipcHandlers';
import { setupTaskProcessor } from './helpers/taskProcessor';
import { setupSystemInfoManager } from './helpers/systemInfoManager';
import { setupStoreHandlers, store } from './helpers/storeManager';
import { setupTaskManager } from './helpers/taskManager';
import {
  initializeWorkItemStore,
  setupWorkItemStoreLifecycle,
} from './helpers/workItemStore';
import { setupWorkItemHandlers } from './helpers/workItemHandlers';
import { setupAutoUpdater } from './helpers/updater';
import { setupAppMenu } from './helpers/menu';
import { setupWindowCloseBehavior, markQuitting } from './helpers/windowClose';
import { setupParameterHandlers } from './helpers/ipcParameterHandlers';
import { setupProofreadHandlers } from './helpers/ipcProofreadHandlers';
import { setupSubtitleMergeHandlers } from './helpers/ipcSubtitleMergeHandlers';
import { configurationManager } from './service/configurationManager';
import {
  registerAddonIpcHandlers,
  setMainWindowForAddon,
} from './helpers/ipcAddonHandlers';
import {
  registerEngineIpcHandlers,
  setMainWindowForEngine,
} from './helpers/ipcEngineHandlers';
import { shutdownPythonRuntime } from './helpers/pythonRuntime';
import { maybeAutoCheckPyEngineUpdate } from './helpers/pythonRuntime/autoUpdateCheck';
import { cleanupLegacyPyEngine } from './helpers/pythonRuntime/legacyCleanup';
import { applyProxyFromSettings } from './helpers/network/proxyManager';
import { setupNetworkHandlers } from './helpers/ipcNetworkHandlers';
import {
  applyMacAppBranding,
  resolveAppIcon,
  setAppDisplayNameEarly,
} from './helpers/appBranding';
import { getDevSimulationConfig, getGpuEnvironment } from './helpers/cudaUtils';

//控制台出现中文乱码，需要去node_modules\electron\cli.js中修改启动代码页

const isProd = process.env.NODE_ENV === 'production';

// media:// 需在 webSecurity:true 下注册为 privileged scheme（必须在 app ready 之前）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      bypassCSP: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

/** 回退开关：SMARTSUB_LEGACY_WEB_SECURITY=true 恢复旧行为 */
const useLegacyWebSecurity =
  process.env.SMARTSUB_LEGACY_WEB_SECURITY === 'true';

// macOS 开发态：须在 ready 前设置，否则菜单栏仍显示 Electron
setAppDisplayNameEarly();

if (isProd) {
  serve({ directory: 'app' });
} else {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

let runtimeShutdownDone = false;
app.on('before-quit', (event) => {
  // 真退出标记集中在 windowClose 模块，close 监听据此放行
  markQuitting();
  if (!runtimeShutdownDone) {
    event.preventDefault();
    runtimeShutdownDone = true;
    void shutdownPythonRuntime().finally(() => {
      app.exit(0);
    });
  }
});

(async () => {
  await app.whenReady();
  applyMacAppBranding();

  const sim = getDevSimulationConfig();
  if (sim?.enabled) {
    console.log(
      `[SmartSub] CUDA dev simulation ON → platform=${sim.platform}, gpu=${sim.gpuName}`,
    );
  }

  // 注册自定义协议处理本地媒体文件
  protocol.registerFileProtocol('media', (request, callback) => {
    const url = request.url.substr(8); // 移除 "media://" 部分
    try {
      const decodedUrl = decodeURIComponent(url);
      return callback({ path: decodedUrl });
    } catch (error) {
      console.error('Protocol handler error:', error);
      return callback({ error: -2 });
    }
  });

  setupStoreHandlers();
  // 代理须在任何联网（providers 初始化 / 下载 / 更新检测）前生效
  applyProxyFromSettings();
  setupParameterHandlers();
  setupProofreadHandlers();
  registerAddonIpcHandlers();

  // Initialize configuration manager
  try {
    await configurationManager.initialize();
    console.log('Configuration Manager initialized');
  } catch (error) {
    console.error('Failed to initialize Configuration Manager:', error);
  }

  const settings = store.get('settings');
  const userLanguage = settings?.language || 'zh'; // 默认为中文

  const mainWindow = createWindow('main', {
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 本地媒体经 media:// 协议加载；紧急回退 SMARTSUB_LEGACY_WEB_SECURITY=true
      webSecurity: !useLegacyWebSecurity,
    },
  });

  mainWindow.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });

  // 关窗行为（macOS 智能模式 / Win·Linux 防误杀）+ Dock 激活恢复
  setupWindowCloseBehavior(mainWindow);

  if (isProd) {
    await mainWindow.loadURL(`app://./${userLanguage}/home/`);
  } else {
    const port = process.argv[2];
    await mainWindow.loadURL(`http://localhost:${port}/${userLanguage}/home/`);
    mainWindow.webContents.openDevTools();
  }

  setupAppMenu(mainWindow);
  setupIpcHandlers(mainWindow);
  setupNetworkHandlers();
  setupTaskProcessor(mainWindow);
  setupSystemInfoManager(mainWindow);
  initializeWorkItemStore();
  setupWorkItemStoreLifecycle();
  setupWorkItemHandlers();
  setupTaskManager();
  setupAutoUpdater(mainWindow);
  setupSubtitleMergeHandlers(mainWindow);
  setMainWindowForAddon(mainWindow);
  registerEngineIpcHandlers();
  setMainWindowForEngine(mainWindow);
  // 清理三层架构改造前遗留的旧 py-engine 目录/状态文件（幂等，失败静默）。
  cleanupLegacyPyEngine();
  // 启动后每日一次的节流静默检查 faster-whisper 运行时更新（非阻塞，失败静默）。
  void maybeAutoCheckPyEngineUpdate(mainWindow);
  // 后台预热 GPU/CUDA 环境检测缓存：首次探测（nvcc / nvidia-smi）较慢，提前异步完成并写入
  // 会话缓存，用户进入「引擎与模型」页时直接命中，避免首屏等待。非阻塞，失败静默。
  void getGpuEnvironment().catch(() => {});
})();

app.on('window-all-closed', () => {
  // macOS 惯例：关窗不退出（任务保活），其余平台正常退出
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
