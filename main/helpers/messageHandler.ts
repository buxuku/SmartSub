import { WebContents } from 'electron';
import { logMessage } from './storeManager';

type MessageType = {
  type?: 'info' | 'error' | 'warning';
  message: string;
};

// 统一的消息发送函数
export function sendMessage(
  sender: WebContents,
  message: string | MessageType,
) {
  let messageObj: MessageType;

  if (typeof message === 'string') {
    messageObj = {
      type: message.toLowerCase().includes('error') ? 'error' : 'info',
      message,
    };
  } else {
    messageObj = message;
  }

  // 记录到日志系统
  logMessage(messageObj.message, messageObj.type);

  // 发送给渲染进程
  sender.send('message', messageObj.message);
}

// 用于替换原有的 event.sender.send('message', error)
export function createMessageSender(sender: WebContents) {
  return {
    send: (channel: string, message: string | MessageType) => {
      if (channel === 'message') {
        sendMessage(sender, message);
      } else {
        sender.send(channel, message);
      }
    },
  };
}
