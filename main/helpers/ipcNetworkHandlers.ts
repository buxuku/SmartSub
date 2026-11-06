import { ipcMain } from '../automation/handlers';
import { testProxyConnectivity } from './network/proxyManager';

export function setupNetworkHandlers(): void {
  ipcMain.handle('proxy:test', async (_event, testUrl?: string) => {
    return testProxyConnectivity(testUrl);
  });
}
