/**
 * Window type declarations for SmartSub
 *
 * Extends the global Window interface with Electron IPC functionality
 * and application-specific methods.
 */

declare global {
  interface Window {
    ipc?: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      send: (channel: string, ...args: any[]) => void;
      on: (channel: string, callback: (...args: any[]) => void) => () => void;
    };
  }
}

export {};
