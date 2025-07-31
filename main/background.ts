import path from 'path';
import { app, protocol } from 'electron';
import fs from 'fs';
import serve from 'electron-serve';
import { createWindow } from './helpers/create-window';
import { setupIpcHandlers } from './helpers/ipcHandlers';
import { setupTaskProcessor } from './helpers/taskProcessor';
import { setupSystemInfoManager } from './helpers/systemInfoManager';
import { setupStoreHandlers, store } from './helpers/storeManager';
import { setupTaskManager } from './helpers/taskManager';
import { setupAutoUpdater } from './helpers/updater';
import { setupParameterHandlers } from './helpers/ipcParameterHandlers';
import { configurationManager } from './service/configurationManager';

//控制台出现中文乱码，需要去node_modules\electron\cli.js中修改启动代码页

const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  serve({ directory: 'app' });
} else {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

(async () => {
  await app.whenReady();

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
    width: 1400,
    height: 1040,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 允许加载本地资源
      webSecurity: false,
    },
  });

  mainWindow.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });

  if (isProd) {
    await mainWindow.loadURL(`app://./${userLanguage}/home/`);
  } else {
    const port = process.argv[2];
    await mainWindow.loadURL(`http://localhost:${port}/${userLanguage}/home/`);
    mainWindow.webContents.openDevTools();
  }

  setupIpcHandlers(mainWindow);
  setupTaskProcessor(mainWindow);
  setupSystemInfoManager(mainWindow);
  setupTaskManager();
  setupAutoUpdater(mainWindow);
})();

app.on('window-all-closed', () => {
  app.quit();
});
