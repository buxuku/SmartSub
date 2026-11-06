import { ipcMain as electronIpc } from 'electron';

type Handler = (event: any, ...args: any[]) => any;
const requests = new Map<string, Handler>();
const commands = new Map<string, Handler[]>();

/** One implementation for desktop IPC and explicit automation adapters.
 * This is a registration facade, not a public arbitrary-IPC endpoint.
 */
export const ipcMain = {
  handle(channel: string, handler: Handler) {
    if (requests.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
    requests.set(channel, handler);
    electronIpc.handle(channel, handler);
  },
  on(channel: string, handler: Handler) {
    commands.set(channel, [...(commands.get(channel) || []), handler]);
    electronIpc.on(channel, handler);
  },
};

export async function invokeHandler(
  channel: string,
  event: any,
  ...args: any[]
) {
  const handler = requests.get(channel);
  if (!handler) throw new Error(`OPERATION_UNAVAILABLE: ${channel}`);
  return handler(event, ...args);
}

export async function sendHandler(channel: string, event: any, ...args: any[]) {
  const listeners = commands.get(channel);
  if (!listeners?.length) throw new Error(`OPERATION_UNAVAILABLE: ${channel}`);
  for (const handler of listeners) await handler(event, ...args);
}
