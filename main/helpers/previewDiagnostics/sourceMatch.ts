/**
 * 在 desktopCapturer 列出的窗口里认出「自己的窗口」（纯函数，不依赖 electron，便于直接测试）。
 *
 * 窗口源的 id 形如 `window:<HWND>:<other>`。BrowserWindow.getMediaSourceId() 给出的 other 是
 * Chromium 内部的 aura 窗口号，而 desktopCapturer 列出来的 other 恒为 0，整串比较永远对不上：
 * 第一次在 Windows 的 CI 虚拟机上跑就是「window source not found (1 sources)」——
 * 那唯一的一个源其实就是我们自己的窗口。所以只比窗口句柄这一段。
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
