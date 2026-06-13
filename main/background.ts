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
import {
  applyMacAppBranding,
  resolveAppIcon,
  setAppDisplayNameEarly,
} from './helpers/appBranding';
import { getDevSimulationConfig } from './helpers/cudaUtils';

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

/** Cmd+Q / 菜单退出时置位：区分「关窗」与「真退出」 */
let isQuitting = false;
let runtimeShutdownDone = false;
app.on('before-quit', (event) => {
  isQuitting = true;
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

  // macOS：关窗仅隐藏，后台任务（转写/翻译）继续；Cmd+Q 真退出
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // macOS：点击 Dock 图标恢复窗口
  app.on('activate', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  if (isProd) {
    await mainWindow.loadURL(`app://./${userLanguage}/home/`);
  } else {
    const port = process.argv[2];
    await mainWindow.loadURL(`http://localhost:${port}/${userLanguage}/home/`);
    mainWindow.webContents.openDevTools();
  }

  setupAppMenu(mainWindow);
  setupIpcHandlers(mainWindow);
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
})();

app.on('window-all-closed', () => {
  // macOS 惯例：关窗不退出（任务保活），其余平台正常退出
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
