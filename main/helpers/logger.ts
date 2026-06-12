import { BrowserWindow } from 'electron';
import { store } from './store';
import { LogEntry } from './store/types';
import { sanitizeLogMessage } from './utils';
import { getTaskContext } from './taskContext';

export function logMessage(
  message: string | Error,
  type: 'info' | 'error' | 'warning' = 'info',
) {
  const logs = store.get('logs');
  const messageStr =
    message instanceof Error ? message.message : String(message);

  // 对日志消息进行脱敏处理，防止泄露敏感信息
  const sanitizedMessage = sanitizeLogMessage(messageStr);

  const projectId = getTaskContext()?.projectId;
  const newLog: LogEntry = {
    message: sanitizedMessage,
    type,
    timestamp: Date.now(),
    ...(projectId ? { projectId } : {}),
  };
  store.set('logs', [...logs, newLog]);

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('newLog', newLog);
  });
}
