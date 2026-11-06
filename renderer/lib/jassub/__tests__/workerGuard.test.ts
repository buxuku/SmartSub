/**
 * @jest-environment node
 */
import { SYNC_CANVAS_GUARD } from '../syncCanvasGuard';

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';

const globals = globalThis as unknown as {
  OffscreenCanvas?: unknown;
  navigator?: unknown;
};

function withWorkerGlobals<T>(userAgent: string, run: () => T): T {
  const saved = {
    OffscreenCanvas: Object.getOwnPropertyDescriptor(
      globalThis,
      'OffscreenCanvas',
    ),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  class FakeOffscreenCanvas {
    getContext() {
      return null;
    }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: FakeOffscreenCanvas,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent },
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globals as Record<string, unknown>)[name];
    }
  }
}

// 这个模块就是 loader 注入进 JASSUB Worker 的那一行 import：导入即生效。
function guardedAfterImporting(userAgent: string): boolean {
  return withWorkerGlobals(userAgent, () => {
    jest.isolateModules(() => {
      require('../workerGuard');
    });
    const { prototype } = globals.OffscreenCanvas as {
      prototype: Record<string, Record<symbol, unknown>>;
    };
    return prototype.getContext[SYNC_CANVAS_GUARD] === true;
  });
}

describe('workerGuard (injected into the JASSUB worker entry)', () => {
  it('installs the guard as a side effect of being imported on Windows', () => {
    expect(guardedAfterImporting(WINDOWS_UA)).toBe(true);
  });

  it('does nothing when imported on macOS', () => {
    expect(guardedAfterImporting(MAC_UA)).toBe(false);
  });
});
