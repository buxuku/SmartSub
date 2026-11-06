import fs from 'fs';

/**
 * 等价于 `mkdir -p`，但目录已经存在时不再调用 mkdir。
 *
 * Windows 上对「已存在的卷根」（`F:\`）调用 `fs.mkdir` 会抛 EPERM，即使带 `recursive: true`：
 * CreateDirectory 对卷根返回 ERROR_ACCESS_DENIED 而不是 ERROR_ALREADY_EXISTS，libuv 把它映射成
 * EPERM，而 Node 的递归 mkdir 只在 EEXIST 时才会 stat 确认「已经是目录」（见 Node 文档 fs.mkdir）。
 * 视频或下载目录直接位于盘符根目录时，需要确保存在的那个目录恰好就是卷根本身（issue #590）。
 *
 * 先 stat：已经是目录就什么都不做；不存在则照常创建；路径上被文件占用时仍交给 mkdir 抛出原来的错误。
 */
export function ensureDirectorySync(directory: string): void {
  if (fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;
  fs.mkdirSync(directory, { recursive: true });
}
