import { EventEmitter } from 'events';
import { BrowserWindow, session } from 'electron';

export const automationEvents = new EventEmitter();
automationEvents.setMaxListeners(100);
let nextOwner = -1;

export function broadcast(channel: string, ...args: any[]) {
  automationEvents.emit('event', channel, ...args);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, ...args);
  }
}

/** Service identity: negative IDs can never collide with Electron WebContents. */
export function createServiceEvent(
  onEvent?: (channel: string, ...args: any[]) => void,
) {
  const sender = Object.assign(new EventEmitter(), {
    id: nextOwner--,
    isAutomation: true,
    isDestroyed: () => false,
    send(channel: string, ...args: any[]) {
      onEvent?.(channel, ...args);
      sender.emit(channel, ...args);
      automationEvents.emit('event', channel, ...args);
    },
  });
  return { sender, reply: sender.send.bind(sender) };
}

export const backgroundEvent = createServiceEvent((channel, ...args) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, ...args);
  }
});

/** Legacy handler progress target. No renderer or hidden BrowserWindow is created.
 * Dialog-only operations are not exposed by the automation catalog.
 */
export function createWindowPort(
  getWindow: () => BrowserWindow | undefined,
): BrowserWindow {
  return new Proxy({} as BrowserWindow, {
    get(_target, key) {
      if (key === '__automationWindow') return getWindow;
      if (key === 'webContents')
        return {
          ...backgroundEvent.sender,
          id: backgroundEvent.sender.id,
          session: session.defaultSession,
          send: broadcast,
          getURL: () => getWindow()?.webContents.getURL() || 'app://./',
          isDestroyed: () => false,
        };
      if (key === 'isDestroyed') return () => false;
      const win = getWindow();
      const value = win?.[key as keyof BrowserWindow];
      return typeof value === 'function'
        ? value.bind(win)
        : (value ?? (() => {}));
    },
  });
}

export function dialogWindow(window: BrowserWindow): BrowserWindow {
  return (window as any)?.__automationWindow?.() || window;
}
