import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { useJassubPreview } from '../subtitleMerge/hooks/useJassubPreview';
import { getDefaultStyle } from '../subtitleMerge/constants';
import { alphaBounds } from '../subtitleMerge/hooks/useSubtitleBounds';

const mockInstances: any[] = [];
let mockReady: () => Promise<void>;
let mockDestroyFails = false;
let mockRenderFails = false;
let mockEvents: object[] = [];
jest.mock('jassub', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options) => {
    const instance = {
      options,
      ready: mockReady(),
      setVideo: jest.fn().mockResolvedValue(undefined),
      manualRender: jest
        .fn()
        .mockImplementation(() =>
          mockRenderFails
            ? Promise.reject(new Error('render failed'))
            : Promise.resolve(),
        ),
      resize: jest.fn().mockResolvedValue(undefined),
      destroy: jest
        .fn()
        .mockImplementation(() =>
          mockDestroyFails
            ? Promise.reject(new Error('ready failed'))
            : Promise.resolve(),
        ),
      _worker: Object.assign(new EventTarget(), { terminate: jest.fn() }),
      renderer: {
        getEvents: jest.fn().mockImplementation(async () => mockEvents),
        setTrack: jest.fn().mockResolvedValue(undefined),
        addFonts: jest.fn().mockResolvedValue(undefined),
        setDefaultFont: jest.fn().mockResolvedValue(undefined),
      },
    };
    mockInstances.push(instance);
    return instance;
  }),
}));

let invoke: jest.Mock;
let video: HTMLVideoElement;
const style = getDefaultStyle();
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);
const options = () => ({ videoEl: video, subtitlePath: 'first.srt', style });
async function tick() {
  await act(async () => {
    jest.advanceTimersByTime(250);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  jest.useFakeTimers();
  mockInstances.length = 0;
  mockReady = () => Promise.resolve();
  mockDestroyFails = false;
  mockRenderFails = false;
  mockEvents = [];
  invoke = jest.fn().mockImplementation(async (channel, payload) =>
    channel === 'subtitleMerge:buildPreviewAss'
      ? {
          success: true,
          data: `${payload.subtitlePath}:${payload.style.fontSize}`,
        }
      : {
          success: true,
          data: { fontName: payload.fontName, data: [1, 2, 3] },
        },
  );
  window.ipc = { invoke } as any;
  video = document.createElement('video');
  Object.defineProperties(video, {
    videoWidth: { value: 640 },
    videoHeight: { value: 360 },
  });
  document.body.appendChild(video);
});
afterEach(() => {
  jest.restoreAllMocks();
  video.remove();
  jest.useRealTimers();
});

it('renders in StrictMode, awaits repaint, and releases canvas/debug handle on unmount', async () => {
  const { result, unmount } = renderHook(useJassubPreview, {
    initialProps: options(),
    wrapper,
  });
  await tick();
  expect(result.current.active).toBe(true);
  expect(mockInstances).toHaveLength(1);
  expect(mockInstances[0].setVideo).toHaveBeenCalledWith(video);
  expect(document.querySelectorAll('.JASSUB')).toHaveLength(1);
  unmount();
  expect(mockInstances[0].destroy).toHaveBeenCalledTimes(1);
  expect((window as any).__jassubPreview).toBeUndefined();
  expect(document.querySelectorAll('.JASSUB')).toHaveLength(0);
});

it('reports the native script anchor for implicit positioning and event margin/alignment overrides', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:buildPreviewAss'
      ? Promise.resolve({
          success: true,
          data: '[Script Info]\nPlayResY: 640\n',
        })
      : original(channel, payload),
  );
  mockEvents = [{ Start: 0, Duration: 1000, Text: '{\\an7}TOP', MarginV: 80 }];
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: { ...options(), currentTime: 0.5 },
  });
  await tick();
  expect(result.current.positionY).toBe(12.5);
  rerender({ ...options(), currentTime: 2 });
  expect(result.current.positionY).toBeUndefined();
  mockEvents = [{ Start: 0, Duration: 1000, Text: 'BOTTOM', MarginV: 0 }];
  act(() => result.current.retry());
  rerender({ ...options(), currentTime: 0.5 });
  await tick();
  expect(result.current.positionY).toBe(((640 - style.marginV) / 640) * 100);
});

it('reports IPC failure and retries the same file', async () => {
  invoke.mockResolvedValueOnce({ success: false, error: 'ENOENT' });
  const { result } = renderHook(useJassubPreview, { initialProps: options() });
  await tick();
  expect(result.current.error).toBe('ENOENT');
  expect(result.current.active).toBe(false);
  act(() => result.current.retry());
  await tick();
  expect(result.current.error).toBeNull();
  expect(result.current.active).toBe(true);
});

it('translates the rendered layer and reported anchor, then clears the transform on reset', async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'subtitleMerge:buildPreviewAss'
      ? Promise.resolve({
          success: true,
          data: '[Script Info]\nPlayResY: 288\n',
          translateY: payload.style.positionY === 60 ? 0.1 : 0,
        })
      : original(channel, payload),
  );
  mockEvents = [{ Start: 0, Duration: 1000, Text: '{\\an5}CENTER' }];
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: { ...options(), style: { ...style, positionY: 60 } },
  });
  await tick();
  expect(result.current.positionY).toBe(60);
  expect(
    (document.querySelector('.JASSUB') as HTMLElement).style.transform,
  ).toBe('translateY(10%)');
  rerender({ ...options(), style: { ...style, positionY: 50 } });
  await tick();
  expect(result.current.positionY).toBe(50);
  expect(
    (document.querySelector('.JASSUB') as HTMLElement).style.transform,
  ).toBe('');
});

it('uses literal zero event margins in the translated document', async () => {
  mockEvents = [{ Start: 0, Duration: 1000, Text: 'BOTTOM', MarginV: 0 }];
  const { result } = renderHook(useJassubPreview, {
    initialProps: { ...options(), style: { ...style, positionY: 100 } },
  });
  await tick();
  expect(result.current.positionY).toBe(100);
});

it('recovers a failed preview after correcting a partially typed style', async () => {
  invoke.mockResolvedValueOnce({
    success: false,
    error: 'Invalid subtitle style: primaryColor',
  });
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: { ...options(), style: { ...style, primaryColor: '#F' } },
  });
  await tick();
  expect(result.current.active).toBe(false);
  rerender({ ...options(), style: { ...style, primaryColor: '#FFFFFF' } });
  await tick();
  expect(result.current.error).toBeNull();
  expect(result.current.active).toBe(true);
});

it('cleans up failed initialization including a worker whose destroy rejects', async () => {
  mockReady = () => Promise.reject(new Error('WASM failed'));
  mockDestroyFails = true;
  const { result } = renderHook(useJassubPreview, { initialProps: options() });
  await tick();
  expect(result.current.error).toBe('WASM failed');
  expect(mockInstances[0]._worker.terminate).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll('.JASSUB')).toHaveLength(0);
});

it('ignores a late file response without touching the replacement renderer', async () => {
  let release!: (value: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: options(),
  });
  await tick();
  rerender({ ...options(), subtitlePath: 'second.srt' });
  await tick();
  expect(result.current.active).toBe(true);
  await act(async () => release({ success: true, data: 'OLD' }));
  expect(mockInstances).toHaveLength(1);
  expect(mockInstances[0].options.subContent).toMatch(/^second.srt:/);
  expect(mockInstances[0].destroy).not.toHaveBeenCalled();
});

it('awaits asynchronous track failures, hides stale output, and recovers on file switch', async () => {
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: options(),
  });
  await tick();
  mockInstances[0].renderer.setTrack.mockRejectedValue(
    new Error('track failed'),
  );
  rerender({ ...options(), style: { ...style, fontSize: 30 } });
  expect(result.current.active).toBe(false);
  await tick();
  expect(result.current.error).toBe('track failed');
  expect(mockInstances[0].destroy).toHaveBeenCalled();
  rerender({ ...options(), subtitlePath: 'second.srt' });
  await tick();
  expect(result.current.active).toBe(true);
  expect(result.current.error).toBeNull();
});

it('serializes track writes so a slow old style cannot finish after the latest style', async () => {
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: options(),
  });
  await tick();
  let release!: () => void;
  mockInstances[0].renderer.setTrack.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  rerender({ ...options(), style: { ...style, fontSize: 30 } });
  await tick();
  rerender({ ...options(), style: { ...style, fontSize: 40 } });
  await tick();
  expect(mockInstances[0].renderer.setTrack).toHaveBeenCalledTimes(1);
  await act(async () => release());
  await tick();
  expect(mockInstances[0].renderer.setTrack).toHaveBeenLastCalledWith(
    'first.srt:40',
  );
  expect(result.current.active).toBe(true);
});

it('surfaces missing font data instead of silently rendering a different font', async () => {
  invoke
    .mockResolvedValueOnce({ success: true, data: 'ASS' })
    .mockResolvedValueOnce({ success: false, error: 'missing font' });
  const { result } = renderHook(useJassubPreview, { initialProps: options() });
  await tick();
  expect(result.current.error).toBe('missing font');
  expect(mockInstances).toHaveLength(0);
});

it('preloads all explicit glyph fallbacks and restores the default when selecting a cached font', async () => {
  invoke.mockImplementation(async (channel, payload) =>
    channel === 'subtitleMerge:buildPreviewAss'
      ? {
          success: true,
          data: 'ASS',
          fontName: payload.style.fontName,
          fontNames: [payload.style.fontName, 'CJK'],
          fontSubstituted: false,
        }
      : {
          success: true,
          data: { fontName: payload.fontName, data: [1, 2, 3] },
        },
  );
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: { ...options(), style: { ...style, fontName: 'First' } },
  });
  await tick();
  expect(mockInstances[0].options.fonts).toHaveLength(2);
  rerender({ ...options(), style: { ...style, fontName: 'Second' } });
  await tick();
  expect(mockInstances[0].renderer.addFonts).toHaveBeenCalledTimes(1);
  rerender({ ...options(), style: { ...style, fontName: 'First' } });
  await tick();
  expect(mockInstances[0].renderer.addFonts).toHaveBeenCalledTimes(1);
  expect(mockInstances[0].renderer.setDefaultFont).toHaveBeenLastCalledWith(
    'First',
  );
  expect(result.current.fontSubstituted).toBe(false);
});

it('cleans up pending initialization on unmount without publishing the late renderer', async () => {
  let release!: () => void;
  mockReady = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const { unmount } = renderHook(useJassubPreview, { initialProps: options() });
  await tick();
  expect(mockInstances).toHaveLength(1);
  unmount();
  await act(async () => release());
  expect(mockInstances[0].destroy).toHaveBeenCalledTimes(1);
  expect(mockInstances[0].setVideo).not.toHaveBeenCalled();
  expect((window as any).__jassubPreview).toBeUndefined();
});

it('loads embedded bytes without a system lookup and replaces the renderer when same-name font content changes', async () => {
  let id = 'first';
  invoke.mockImplementation(async () => ({
    success: true,
    data: '[Script Info]\nPlayResY: 288\n',
    fontName: 'Embedded',
    fontNames: ['Embedded'],
    fontSubstituted: false,
    embeddedFonts: [
      { fontNames: ['Embedded'], id, data: id === 'first' ? [1, 2] : [3, 4] },
    ],
  }));
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: options(),
  });
  await tick();
  expect(mockInstances[0].options.fonts).toEqual([new Uint8Array([1, 2])]);
  expect(
    invoke.mock.calls.every(
      ([channel]) => channel === 'subtitleMerge:buildPreviewAss',
    ),
  ).toBe(true);
  rerender({ ...options(), style: { ...style, fontSize: 30 } });
  await tick();
  expect(mockInstances).toHaveLength(1);
  id = 'second';
  rerender({ ...options(), style: { ...style, fontSize: 31 } });
  await tick();
  expect(mockInstances[0].destroy).toHaveBeenCalledTimes(1);
  expect(mockInstances).toHaveLength(2);
  expect(mockInstances[1].options.fonts).toEqual([new Uint8Array([3, 4])]);
  expect(result.current.active).toBe(true);
});

it('reports asynchronous repaint failure and recovers after changing video', async () => {
  const { result, rerender } = renderHook(useJassubPreview, {
    initialProps: options(),
  });
  await tick();
  mockRenderFails = true;
  rerender({ ...options(), style: { ...style, fontSize: 30 } });
  await tick();
  expect(result.current.error).toBe('render failed');
  mockRenderFails = false;
  const replacement = document.createElement('video');
  rerender({ ...options(), videoEl: replacement });
  await tick();
  expect(result.current.active).toBe(true);
  expect(result.current.error).toBeNull();
});

it('observes a rejected playback repaint even when the library does not await it', async () => {
  const { result } = renderHook(useJassubPreview, { initialProps: options() });
  await tick();
  mockRenderFails = true;
  await act(async () => {
    void mockInstances[0].manualRender({
      mediaTime: 1,
      width: 640,
      height: 360,
    });
  });
  expect(result.current.error).toBe('render failed');
  expect(result.current.active).toBe(false);
});

it('reports worker failure during continuous playback and retries with a fresh renderer', async () => {
  const { result } = renderHook(useJassubPreview, { initialProps: options() });
  await tick();
  const original = mockInstances[0];
  act(() =>
    original._worker.dispatchEvent(
      new ErrorEvent('error', { message: 'playback worker failed' }),
    ),
  );
  expect(result.current.error).toBe('playback worker failed');
  expect(result.current.active).toBe(false);
  expect(original.destroy).toHaveBeenCalledTimes(1);
  act(() => result.current.retry());
  await tick();
  expect(mockInstances).toHaveLength(2);
  expect(result.current.active).toBe(true);
  act(() =>
    original._worker.dispatchEvent(
      new ErrorEvent('error', { message: 'stale error' }),
    ),
  );
  expect(result.current.error).toBeNull();
});

it('measures visible alpha bounds, ignores near-transparent pixels and handles empty frames', () => {
  const pixels = new Uint8ClampedArray(10 * 20 * 4);
  expect(alphaBounds(pixels, 10, 20)).toBeNull();
  pixels[3] = 15;
  pixels[(5 * 10 + 2) * 4 + 3] = 255;
  pixels[(9 * 10 + 6) * 4 + 3] = 16;
  expect(alphaBounds(pixels, 10, 20)).toEqual({
    left: 0.2,
    top: 0.25,
    width: 0.5,
    height: 0.25,
  });
  expect(alphaBounds(new Uint8ClampedArray(), 0, 0)).toBeNull();
});
