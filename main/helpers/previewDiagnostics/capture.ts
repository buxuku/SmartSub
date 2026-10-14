/**
 * 抓取「视频区域现在到底是什么颜色」，分两层：
 *
 *  - viz：webContents.capturePage，取的是 Chromium 合成器的输出（会发起 copy request，
 *    这会让 Chromium 暂时放弃 DirectComposition 叠加层——所以它「看到」的往往比肉眼正常）；
 *  - os：desktopCapturer 抓整个窗口，取的是 Windows 桌面合成器（DWM）最终给出的画面，
 *    和用户肉眼、Win+Shift+S 截图是同一层。只在 Windows 上做，避免 macOS 弹屏幕录制授权。
 *
 * 两层对比：os 黑而 viz 正常 ⇒ 问题在呈现层（DirectComposition / MPO / 驱动）；
 * 两层都黑 ⇒ 问题在 Chromium 合成之前。结果同时写进日志和 PNG。
 */
import { desktopCapturer, screen, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { lumaStats, type LumaStats } from './luminance';
import { findOwnWindowSource } from './sourceMatch';

/** 相对页面左上角的矩形，单位 CSS 像素（getBoundingClientRect 的结果）。 */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CaptureLayer = 'viz' | 'os';

export interface CaptureResult {
  layer: CaptureLayer;
  ok: boolean;
  error?: string;
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
  try {
    const bounds = win.getBounds();
    const content = win.getContentBounds();
    const scale = screen.getDisplayMatching(bounds).scaleFactor || 1;
    const sources = await withTimeout(
      desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: {
          width: Math.round(bounds.width * scale),
          height: Math.round(bounds.height * scale),
        },
        fetchWindowIcons: false,
      }),
      OS_CAPTURE_TIMEOUT_MS,
      'desktopCapturer.getSources',
    );
    const mediaSourceId = win.getMediaSourceId();
    const mine = findOwnWindowSource(sources, {
      mediaSourceId,
      nativeHandle: nativeHandleOf(win),
      title: win.getTitle(),
    });
    if (!mine || mine.thumbnail.isEmpty()) {
      throw new Error(
        mine
          ? 'window thumbnail is empty'
          : // id 只是句柄数字，不含窗口标题：别的窗口叫什么是用户的隐私，不进日志
            `window source not found: own ${mediaSourceId}, listed [${sources
              .map((source) => source.id)
              .join(', ')}]`,
      );
    }
    // 缩略图是整个窗口（含边框），页面内容相对窗口左上角有一点偏移
    const offset: CssRect = {
      x: content.x - bounds.x + rect.x,
      y: content.y - bounds.y + rect.y,
      width: rect.width,
      height: rect.height,
    };
    return await analyze(
      'os',
      mine.thumbnail,
      offset,
      bounds.width,
      dir,
      name,
      started,
    );
  } catch (error) {
    return {
      layer: 'os',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      video: null,
      whole: null,
      elapsedMs: Date.now() - started,
    };
  }
}
