/**
 * @jest-environment node
 */
import {
  SYNC_CANVAS_GUARD,
  installSyncCanvasGuard,
  type GuardScope,
} from '../syncCanvasGuard';

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';

type Call = {
  self: unknown;
  contextId?: string;
  attributes?: unknown;
  rest: unknown[];
};

// 一个只记录「原生 getContext 实际收到了什么」的 OffscreenCanvas 替身。
function createWorkerScope(userAgent?: string) {
  const calls: Call[] = [];
  class FakeOffscreenCanvas {
    getContext(contextId?: string, attributes?: unknown, ...rest: unknown[]) {
      calls.push({ self: this, contextId, attributes, rest });
      return { context: contextId };
    }
  }
  const scope: GuardScope = {
    OffscreenCanvas: FakeOffscreenCanvas,
    ...(userAgent === undefined ? {} : { navigator: { userAgent } }),
  };
  return {
    scope,
    calls,
    canvas: new FakeOffscreenCanvas(),
    originalGetContext: FakeOffscreenCanvas.prototype.getContext,
    protoGetContext: () => FakeOffscreenCanvas.prototype.getContext,
  };
}

describe('installSyncCanvasGuard', () => {
  describe('on Windows', () => {
    it('turns a desynchronized request into a synchronized one', () => {
      const { scope, calls, canvas } = createWorkerScope(WINDOWS_UA);

      expect(installSyncCanvasGuard(scope)).toBe(true);
      canvas.getContext('webgl2', { desynchronized: true });

      expect(calls).toHaveLength(1);
      expect(calls[0].attributes).toEqual({ desynchronized: false });
    });

    it('keeps every other requested attribute', () => {
      const { scope, calls, canvas } = createWorkerScope(WINDOWS_UA);
      installSyncCanvasGuard(scope);

      canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        powerPreference: 'high-performance',
        desynchronized: true,
      });

      expect(calls[0].attributes).toEqual({
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        powerPreference: 'high-performance',
        desynchronized: false,
      });
    });

    it.each(['webgl2', 'webgl', '2d'])(
      'covers the %s context JASSUB can fall back to',
      (contextId) => {
        const { scope, calls, canvas } = createWorkerScope(WINDOWS_UA);
        installSyncCanvasGuard(scope);

        canvas.getContext(contextId, { desynchronized: true });

        expect(calls[0].contextId).toBe(contextId);
        expect(calls[0].attributes).toEqual({ desynchronized: false });
      },
    );

    it('does not mutate the attributes object the caller passed in', () => {
      const { scope, calls, canvas } = createWorkerScope(WINDOWS_UA);
      installSyncCanvasGuard(scope);
      const requested = { alpha: true, desynchronized: true };

      canvas.getContext('webgl2', requested);

      expect(requested).toEqual({ alpha: true, desynchronized: true });
      expect(calls[0].attributes).not.toBe(requested);
    });

    it.each([
      ['an explicit desynchronized: false', { desynchronized: false }],
      ['no desynchronized key', { alpha: true }],
    ])('forwards the very same object for %s', (_name, requested) => {
      const { scope, calls, canvas } = createWorkerScope(WINDOWS_UA);
      installSyncCanvasGuard(scope);

      canvas.getContext('webgl2', requested);

      expect(calls[0].attributes).toBe(requested);
    });

    it.each([
      ['omitted attributes', undefined],
      ['null attributes', null],
    ])('forwards %s untouched', (_name, requested) => {
      const { scope, calls, canvas } = createWorkerScope(WINDOWS_UA);
      installSyncCanvasGuard(scope);

      canvas.getContext('2d', requested);

      expect(calls[0].attributes).toBe(requested);
    });

    it('keeps the receiver, the extra arguments and the return value', () => {
      const { scope, calls, canvas } = createWorkerScope(WINDOWS_UA);
      installSyncCanvasGuard(scope);

      const context = (
        canvas.getContext as (...args: unknown[]) => unknown
      ).call(canvas, 'webgl2', { desynchronized: true }, 1, 'x');

      expect(context).toEqual({ context: 'webgl2' });
      expect(calls[0].self).toBe(canvas);
      expect(calls[0].rest).toEqual([1, 'x']);
    });

    it('marks the installed guard so other code can detect it', () => {
      const { scope, protoGetContext } = createWorkerScope(WINDOWS_UA);
      installSyncCanvasGuard(scope);

      expect(
        (protoGetContext() as unknown as Record<symbol, unknown>)[
          SYNC_CANVAS_GUARD
        ],
      ).toBe(true);
    });

    it('is idempotent: a second install is a no-op and never stacks a second layer', () => {
      const { scope, protoGetContext } = createWorkerScope(WINDOWS_UA);

      expect(installSyncCanvasGuard(scope)).toBe(true);
      const installed = protoGetContext();
      expect(installSyncCanvasGuard(scope)).toBe(false);

      expect(protoGetContext()).toBe(installed);
    });
  });

  describe('everywhere else', () => {
    it.each([
      ['macOS', MAC_UA],
      ['Linux', LINUX_UA],
    ])('leaves %s alone and keeps the upstream request', (_name, ua) => {
      const { scope, calls, canvas, originalGetContext, protoGetContext } =
        createWorkerScope(ua);

      expect(installSyncCanvasGuard(scope)).toBe(false);
      expect(protoGetContext()).toBe(originalGetContext);

      const requested = { desynchronized: true };
      canvas.getContext('webgl2', requested);
      expect(calls[0].attributes).toBe(requested);
    });

    it('leaves a worker without navigator alone', () => {
      const { scope, originalGetContext, protoGetContext } =
        createWorkerScope();

      expect(installSyncCanvasGuard(scope)).toBe(false);
      expect(protoGetContext()).toBe(originalGetContext);
    });

    it('leaves a worker without OffscreenCanvas alone', () => {
      expect(
        installSyncCanvasGuard({ navigator: { userAgent: WINDOWS_UA } }),
      ).toBe(false);
    });

    it('defaults to the global scope and is harmless where there is no OffscreenCanvas', () => {
      expect(
        typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas,
      ).toBe('undefined');
      expect(installSyncCanvasGuard()).toBe(false);
    });
  });
});
