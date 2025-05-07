import { BrowserWindow } from 'electron';
import { store } from './store';
import { LogEntry } from './store/types';

export function logMessage(
  message: string | Error,
  type: 'info' | 'error' | 'warning' = 'info',
) {
  const logs = store.get('logs');
  const messageStr =
    message instanceof Error ? message.message : String(message);

  const newLog: LogEntry = {
    message: messageStr,
    type,
    timestamp: Date.now(),
  };
  store.set('logs', [...logs, newLog]);

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('newLog', newLog);
  });
}
