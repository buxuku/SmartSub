/**
 * desktopCapturer 的源选择与坐标换算（纯函数，不依赖 electron，便于直接测试）。
 *
 * 窗口源的 id 形如 `window:<HWND>:<other>`；Electron 文档写明 other 对当前进程的窗口是 1，对其它进程的窗口是 0。
 * 所以只有「窗口句柄」这一段才是身份，尾段不参与比较。
 *
 * 这里踩过一个坑，记下来免得重蹈：Windows CI 上第一次报 `window source not found (1 sources)`，
 * 当时猜「那唯一的源就是自己的窗口，只是尾段对不上」，于是改成按句柄比较。第二次带上 id 再跑，
 * 看到的是 `own window:524694:1, listed [window:131584:0]`——列出来的是别的进程的窗口（尾段 0、句柄也不同），
 * 自己的窗口根本没被枚举出来。所以按句柄比较是无害的加固，但并不是那次失败的原因（原因至今未明）；
 * 整屏截取再裁剪不依赖窗口枚举，故作为首选。
 */

/** 取出 `window:<HWND>:<other>` 里的窗口句柄；不是窗口源的 id 返回 null。 */
export function windowHandleOf(id: string): string | null {
  const match = /^window:(\d+):/.exec(id);
  return match ? match[1] : null;
}

export interface SourceLike {
  id: string;
  name?: string;
}

export interface OwnWindowIds {
  /** BrowserWindow.getMediaSourceId() */
  mediaSourceId: string;
  /** BrowserWindow.getNativeWindowHandle() 换算出的十进制 HWND（拿不到就不传） */
  nativeHandle?: string | null;
  /** BrowserWindow.getTitle() */
  title?: string;
}

/**
 * 先按窗口句柄找；句柄对不上时，再按标题找——但标题必须唯一，
 * 否则宁可认为没找到，也不要把别的窗口当成自己（那会让读数毫无意义）。
 */
export function findOwnWindowSource<T extends SourceLike>(
  sources: readonly T[],
  own: OwnWindowIds,
): T | null {
  const handles = new Set<string>();
  const fromId = windowHandleOf(own.mediaSourceId);
  if (fromId) handles.add(fromId);
  if (own.nativeHandle) handles.add(own.nativeHandle);

  const byHandle = sources.find((source) => {
    const handle = windowHandleOf(source.id);
    return handle !== null && handles.has(handle);
  });
  if (byHandle) return byHandle;

  if (own.title) {
    const titled = sources.filter((source) => source.name === own.title);
    if (titled.length === 1) return titled[0];
  }
  return null;
}

export interface ScreenSourceLike {
  id: string;
  /** desktopCapturer 给的屏幕源带 display_id，等于 screen.getAllDisplays() 里对应 Display 的 id */
  display_id?: string;
}

/**
 * 找出「窗口所在那块屏幕」对应的屏幕源。
 * 只认 display_id；取不到时，仅当系统里只有一块屏幕才用它——多块屏幕时不按顺序猜，
 * 猜错了会量到另一块屏幕上的东西，读数就毫无意义，宁可返回 null。
 */
export function pickScreenSource<T extends ScreenSourceLike>(
  sources: readonly T[],
  displayId: number | string,
): T | null {
  const wanted = String(displayId);
  const byDisplay = sources.find((source) => source.display_id === wanted);
  if (byDisplay) return byDisplay;
  const screens = sources.filter((source) => source.id.startsWith('screen:'));
  return screens.length === 1 ? screens[0] : null;
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenGeometryInput {
  /** 窗口外框，DIP，屏幕坐标（BrowserWindow.getBounds） */
  windowBounds: RectLike;
  /** 页面内容区，DIP，屏幕坐标（BrowserWindow.getContentBounds） */
  contentBounds: RectLike;
  /** 窗口所在屏幕，DIP（Display.bounds） */
  displayBounds: RectLike;
  /** 屏幕缩略图的像素尺寸 */
  imageSize: { width: number; height: number };
  /** 视频区域，CSS 像素，相对页面左上角（getBoundingClientRect） */
  videoRect: RectLike;
}

export interface ScreenGeometry {
  /** 从整屏缩略图里裁出窗口的像素矩形（已夹到图内） */
  crop: RectLike;
  /** 视频区域在「裁出来的图」里的像素矩形（可能部分落在图外，统计时会再夹一次） */
  video: RectLike;
}

/**
 * 把「窗口 / 视频区域」从 DIP 屏幕坐标换算成整屏缩略图里的像素矩形。
 * 缩放比用「缩略图像素 / 屏幕 DIP」的实际比值，而不是 scaleFactor——缩略图最终多大以实际为准。
 * 窗口与这块屏幕没有交集（整个在屏幕外）时返回 null。
 */
export function screenCaptureGeometry(
  input: ScreenGeometryInput,
): ScreenGeometry | null {
  const { windowBounds, contentBounds, displayBounds, imageSize, videoRect } =
    input;
  if (
    displayBounds.width <= 0 ||
    displayBounds.height <= 0 ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    return null;
  }
  const sx = imageSize.width / displayBounds.width;
  const sy = imageSize.height / displayBounds.height;

  const left = Math.max(0, Math.round((windowBounds.x - displayBounds.x) * sx));
  const top = Math.max(0, Math.round((windowBounds.y - displayBounds.y) * sy));
  const right = Math.min(
    imageSize.width,
    Math.round((windowBounds.x + windowBounds.width - displayBounds.x) * sx),
  );
  const bottom = Math.min(
    imageSize.height,
    Math.round((windowBounds.y + windowBounds.height - displayBounds.y) * sy),
  );
  if (right <= left || bottom <= top) return null;

  return {
    crop: { x: left, y: top, width: right - left, height: bottom - top },
    video: {
      x: (contentBounds.x - displayBounds.x + videoRect.x) * sx - left,
      y: (contentBounds.y - displayBounds.y + videoRect.y) * sy - top,
      width: videoRect.width * sx,
      height: videoRect.height * sy,
    },
  };
}
