import fs from 'fs';
import { createHash } from 'crypto';

/**
 * 抽取音频缓存的键（issue #510）。
 *
 * 旧实现只对视频绝对路径做 MD5，缓存是否可用仅看文件是否存在：同名同路径的新视频
 * （如网页下载的 videoplayback.mp4 被不同视频反复覆盖）会永远命中旧音频，转写出来的
 * 始终是第一次的字幕。现在把文件大小与修改时间（毫秒）一并纳入——源文件被替换或
 * 重新导出后键随之改变，旧缓存不再被命中。
 *
 * 取舍：
 * - 做「相等性指纹」，而不是「缓存比源文件新就复用」：移动/下载来的新视频会保留较旧的
 *   mtime，后一种判断会继续误用旧缓存。
 * - 不做内容哈希：多 GB 视频全量读盘代价过高；size + mtime 已覆盖「替换同名文件」。
 * - 路径仍参与哈希，避免不同文件仅凭 size + mtime 撞键；产物是 32 位十六进制 ASCII，
 *   中文路径下同样可直接作文件名。
 *
 * 读不到文件状态时返回 null：此时无法证明已有缓存仍对应当前文件，调用方不得复用。
 */
export function getAudioCacheKey(filePath: string): string | null {
  try {
    const { size, mtimeMs } = fs.statSync(filePath);
    return createHash('md5')
      .update(`${filePath}|${size}|${Math.trunc(mtimeMs)}`)
      .digest('hex');
  } catch {
    return null;
  }
}
