import {
  contextBridge,
  ipcRenderer,
  webUtils,
  IpcRendererEvent,
} from 'electron';

const handler = {
  send(channel: string, value: unknown) {
    ipcRenderer.send(channel, value);
  },
  invoke(channel: string, ...args): Promise<any> {
    return ipcRenderer.invoke(channel, ...args);
  },
  // Electron 32+ 移除了 File.path，统一经 webUtils 取拖拽文件的磁盘路径
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  on(channel: string, callback: (...args: unknown[]) => void) {
    const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, subscription);

    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },
};

contextBridge.exposeInMainWorld('ipc', handler);

export type IpcHandler = typeof handler;
