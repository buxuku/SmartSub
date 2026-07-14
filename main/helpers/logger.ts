import { BrowserWindow } from 'electron';
import { LogEntry } from './store/types';
import { appendLog } from './logStorage';
import { sanitizeLogMessage } from './utils';
import { getTaskContext } from './taskContext';

export function logMessage(
  message: string | Error,
  type: 'info' | 'error' | 'warning' = 'info',
) {
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
  appendLog(newLog);

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('newLog', newLog);
  });
}
