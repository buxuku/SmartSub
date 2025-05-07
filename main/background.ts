import path from 'path';
import { app } from 'electron';
import serve from 'electron-serve';
import { createWindow } from './helpers/create-window';
import { setupIpcHandlers } from './helpers/ipcHandlers';
import { setupTaskProcessor } from './helpers/taskProcessor';
import { setupSystemInfoManager } from './helpers/systemInfoManager';
import { setupStoreHandlers, store } from './helpers/storeManager';
import { setupTaskManager } from './helpers/taskManager';

//控制台出现中文乱码，需要去node_modules\electron\cli.js中修改启动代码页

const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  serve({ directory: 'app' });
} else {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

(async () => {
  await app.whenReady();

  setupStoreHandlers();

  const settings = store.get('settings');
  const userLanguage = settings?.language || 'zh'; // 默认为中文

  const mainWindow = createWindow('main', {
    width: 1400,
    height: 1040,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
})();

app.on('window-all-closed', () => {
  app.quit();
});
