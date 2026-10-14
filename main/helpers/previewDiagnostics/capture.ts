/**
 * 抓取「视频区域现在到底是什么颜色」，分两层：
 *
 *  - viz：webContents.capturePage，取的是 Chromium 合成器的输出（会发起 copy request，
 *    这会让 Chromium 暂时放弃 DirectComposition 叠加层——所以它「看到」的往往比肉眼正常）；
 *  - os：desktopCapturer 抓 Windows 桌面合成器（DWM）最终给出的画面，
 *    和用户肉眼、Win+Shift+S 截图是同一层。首选「抓整块屏幕再裁出我们的窗口」，
 *    取不到再退到「按窗口抓」（后者要先在窗口列表里认出自己，CI 虚拟机上就认不出来）。
 *    只在 Windows 上做，避免 macOS 弹屏幕录制授权。
 *
 * 两层对比：os 黑而 viz 正常 ⇒ 问题在呈现层（DirectComposition / MPO / 驱动）；
 * 两层都黑 ⇒ 问题在 Chromium 合成之前。结果同时写进日志和 PNG。
 */
import { desktopCapturer, screen, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { lumaStats, type LumaStats } from './luminance';
import {
  findOwnWindowSource,
  pickScreenSource,
  screenCaptureGeometry,
} from './sourceMatch';

/** 相对页面左上角的矩形，单位 CSS 像素（getBoundingClientRect 的结果）。 */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CaptureLayer = 'viz' | 'os';

/** 系统层是怎么取到的：整屏截取后裁剪，还是按窗口截取。 */
export type OsCaptureMethod = 'screen' | 'window';

export interface CaptureResult {
  layer: CaptureLayer;
  ok: boolean;
  error?: string;
  /** 仅系统层：这次读数用的取法 */
  method?: OsCaptureMethod;
  /** 仅系统层：首选取法失败、退到备选时，首选取法的错误 */
  fallbackFrom?: string;
  /** 诊断目录 captures/ 下的文件名 */
  file?: string;
  imageSize?: { width: number; height: number };
  /** 视频区域的亮度统计 */
  video: LumaStats | null;
  /** 整幅图的亮度统计，视频区域位置不准时拿它兜底 */
  whole: LumaStats | null;
  elapsedMs: number;
}

/** captures/ 里最多保留多少张 PNG，超出删最旧的。 */
export const MAX_CAPTURE_FILES = 24;
/** 存盘时的最大宽度：足够看出黑屏与否，又不至于让诊断包过大。 */
const MAX_SAVED_WIDTH = 1280;
const OS_CAPTURE_TIMEOUT_MS = 6000;

type NativeImageLike = Electron.NativeImage;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 取位图的真实像素尺寸：NativeImage.getSize() 是 DIP，高分屏上和位图长度对不上。 */
function bitmapDimensions(
  image: NativeImageLike,
  bitmap: Buffer,
): { width: number; height: number } | null {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  if (bitmap.length === size.width * size.height * 4) return size;
  const scale = Math.sqrt(bitmap.length / 4 / (size.width * size.height));
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  return width * height * 4 === bitmap.length ? { width, height } : null;
}

async function trimCaptureFiles(dir: string): Promise<void> {
  try {
    const names = (await fs.promises.readdir(dir)).filter((name) =>
      name.endsWith('.png'),
    );
    if (names.length <= MAX_CAPTURE_FILES) return;
    const stats = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: (await fs.promises.stat(path.join(dir, name))).mtimeMs,
      })),
    );
    stats.sort((a, b) => a.mtime - b.mtime);
    for (const { name } of stats.slice(0, stats.length - MAX_CAPTURE_FILES)) {
      await fs.promises.rm(path.join(dir, name), { force: true });
    }
  } catch {
    // 清理失败不影响诊断本身
  }
}

/**
 * @param basisWidth 图像所代表的区域在 CSS/DIP 坐标系下的宽度，用来把 CSS 像素的矩形换算成位图像素：
 *   高分屏上位图比 DIP 大一倍，必须用位图的真实宽度除以它，而不能直接用 NativeImage.getSize()。
 */
async function analyze(
  layer: CaptureLayer,
  image: NativeImageLike,
  region: CssRect,
  basisWidth: number,
  dir: string,
  name: string,
  started: number,
): Promise<CaptureResult> {
  const bitmap = image.toBitmap();
  const dims = bitmapDimensions(image, bitmap);
  if (!dims) {
    return {
      layer,
      ok: false,
      error: 'bitmap size does not match image size',
      video: null,
      whole: null,
      elapsedMs: Date.now() - started,
    };
  }
  const regionScale = dims.width / (basisWidth || 1);
  const video = lumaStats(bitmap, dims.width, dims.height, {
    x: region.x * regionScale,
    y: region.y * regionScale,
    width: region.width * regionScale,
    height: region.height * regionScale,
  });
  const whole = lumaStats(bitmap, dims.width, dims.height);

  await fs.promises.mkdir(dir, { recursive: true });
  const file = `${name}-${layer}.png`;
  const saved =
    dims.width > MAX_SAVED_WIDTH
      ? image.resize({ width: MAX_SAVED_WIDTH })
      : image;
  await fs.promises.writeFile(path.join(dir, file), saved.toPNG());
  void trimCaptureFiles(dir);

  return {
    layer,
    ok: true,
    file,
    imageSize: dims,
    video,
    whole,
    elapsedMs: Date.now() - started,
  };
}

/** 合成器层：整页截图，再按视频区域统计。 */
export async function captureViz(
  win: BrowserWindow,
  rect: CssRect,
  dir: string,
  name: string,
): Promise<CaptureResult> {
  const started = Date.now();
  try {
    const image = await withTimeout(
      win.webContents.capturePage(),
      OS_CAPTURE_TIMEOUT_MS,
      'capturePage',
    );
    return await analyze(
      'viz',
      image,
      rect,
      win.getContentBounds().width,
      dir,
      name,
      started,
    );
  } catch (error) {
    return {
      layer: 'viz',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      video: null,
      whole: null,
      elapsedMs: Date.now() - started,
    };
  }
}

/** HWND 的十进制写法（getNativeWindowHandle 给的是按指针宽度小端排列的字节）；拿不到返回 null。 */
function nativeHandleOf(win: BrowserWindow): string | null {
  try {
    const bytes = win.getNativeWindowHandle();
    if (bytes.length >= 8) return bytes.readBigUInt64LE(0).toString();
    if (bytes.length >= 4) return String(bytes.readUInt32LE(0));
    return null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 按窗口取：窗口列表里偶尔会漏掉自己（窗口一时没响应会被枚举跳过），所以重试几次。 */
const WINDOW_LIST_ATTEMPTS = 3;
const WINDOW_LIST_RETRY_MS = 400;

function failure(
  error: unknown,
  started: number,
  method: OsCaptureMethod,
): CaptureResult {
  return {
    layer: 'os',
    ok: false,
    method,
    error: error instanceof Error ? error.message : String(error),
    video: null,
    whole: null,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 首选：抓窗口所在的整块屏幕，再裁出我们的窗口。
 * 它拿到的是桌面合成之后的最终画面（和 Win+Shift+S 同一层），也不依赖「在窗口列表里认出自己」。
 * 裁剪之后才分析、存盘：PNG 里只有我们窗口范围内的像素，不会带上屏幕其它位置的内容。
 */
async function captureOsByScreen(
  win: BrowserWindow,
  rect: CssRect,
  dir: string,
  name: string,
): Promise<CaptureResult> {
  const started = Date.now();
  try {
    const bounds = win.getBounds();
    const content = win.getContentBounds();
    const display = screen.getDisplayMatching(bounds);
    const scale = display.scaleFactor || 1;
    const sources = await withTimeout(
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.bounds.width * scale),
          height: Math.round(display.bounds.height * scale),
        },
        fetchWindowIcons: false,
      }),
      OS_CAPTURE_TIMEOUT_MS,
      'desktopCapturer.getSources(screen)',
    );
    const source = pickScreenSource(sources, display.id);
    if (!source) {
      throw new Error(
        `screen source not found: display ${display.id}, listed [${sources
          .map((item) => `${item.id}/${item.display_id || '-'}`)
          .join(', ')}]`,
      );
    }
    if (source.thumbnail.isEmpty())
      throw new Error('screen thumbnail is empty');
    const geometry = screenCaptureGeometry({
      windowBounds: bounds,
      contentBounds: content,
      displayBounds: display.bounds,
      imageSize: source.thumbnail.getSize(),
      videoRect: rect,
    });
    if (!geometry) throw new Error('window is outside the captured screen');
    const image = source.thumbnail.crop(geometry.crop);
    // 裁出来的图按 1:1 像素处理：区域已经是像素坐标，basisWidth 取图宽即比例 1
    const result = await analyze(
      'os',
      image,
      geometry.video,
      image.getSize().width,
      dir,
      name,
      started,
    );
    return { ...result, method: 'screen' };
  } catch (error) {
    return failure(error, started, 'screen');
  }
}

/** 备选：按窗口取。要先在 desktopCapturer 的窗口列表里认出自己的窗口。 */
async function captureOsByWindow(
  win: BrowserWindow,
  rect: CssRect,
  dir: string,
  name: string,
): Promise<CaptureResult> {
  const started = Date.now();
  try {
    const bounds = win.getBounds();
    const content = win.getContentBounds();
    const scale = screen.getDisplayMatching(bounds).scaleFactor || 1;
    const mediaSourceId = win.getMediaSourceId();
    let sources: Electron.DesktopCapturerSource[] = [];
    let mine: Electron.DesktopCapturerSource | null = null;
    let attempts = 0;
    while (attempts < WINDOW_LIST_ATTEMPTS && !mine) {
      if (attempts > 0) await sleep(WINDOW_LIST_RETRY_MS);
      attempts += 1;
      sources = await withTimeout(
        desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: {
            width: Math.round(bounds.width * scale),
            height: Math.round(bounds.height * scale),
          },
          fetchWindowIcons: false,
        }),
        OS_CAPTURE_TIMEOUT_MS,
        'desktopCapturer.getSources(window)',
      );
      mine = findOwnWindowSource(sources, {
        mediaSourceId,
        nativeHandle: nativeHandleOf(win),
        title: win.getTitle(),
      });
    }
    if (!mine) {
      // 只记句柄数字和窗口自身的状态，不记别的窗口叫什么——那是用户的隐私。
      // 这些状态正是排查「为什么没被枚举到」要看的：不可见 / 最小化 / 没有标题都会被跳过。
      throw new Error(
        `window source not found after ${attempts} attempts: own ${mediaSourceId}, listed [${sources
          .map((source) => source.id)
          .join(
            ', ',
          )}], visible=${win.isVisible()}, minimized=${win.isMinimized()}, focused=${win.isFocused()}, titleLength=${win.getTitle().length}`,
      );
    }
    if (mine.thumbnail.isEmpty()) throw new Error('window thumbnail is empty');
    // 缩略图是整个窗口（含边框），页面内容相对窗口左上角有一点偏移
    const offset: CssRect = {
      x: content.x - bounds.x + rect.x,
      y: content.y - bounds.y + rect.y,
      width: rect.width,
      height: rect.height,
    };
    const result = await analyze(
      'os',
      mine.thumbnail,
      offset,
      bounds.width,
      dir,
      name,
      started,
    );
    return { ...result, method: 'window' };
  } catch (error) {
    return failure(error, started, 'window');
  }
}

/** 系统层：只在 Windows 上做（macOS 上会触发屏幕录制授权弹窗）。 */
export async function captureOs(
  win: BrowserWindow,
  rect: CssRect,
  dir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): Promise<CaptureResult> {
  const started = Date.now();
  if (platform !== 'win32') {
    return {
      layer: 'os',
      ok: false,
      error: `skipped on ${platform}`,
      video: null,
      whole: null,
      elapsedMs: 0,
    };
  }
  const viaScreen = await captureOsByScreen(win, rect, dir, name);
  if (viaScreen.ok) return viaScreen;
  const viaWindow = await captureOsByWindow(win, rect, dir, name);
  if (viaWindow.ok) {
    return { ...viaWindow, fallbackFrom: `screen: ${viaScreen.error}` };
  }
  return {
    layer: 'os',
    ok: false,
    error: `screen: ${viaScreen.error}; window: ${viaWindow.error}`,
    video: null,
    whole: null,
    elapsedMs: Date.now() - started,
  };
}
