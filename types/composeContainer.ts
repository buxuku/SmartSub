/**
 * 合成输出容器的可写性（纯函数，主进程与渲染层共用，不依赖 node:path / electron）。
 *
 * 合成引擎的每种成片形态都写 H.264（硬烧重编码）或 AAC（配音换轨/混音），而 WebM/Ogg 的
 * muxer 只接受 VP8/VP9/AV1 视频与 Vorbis/Opus 音频，在写头阶段就失败：
 * `Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are
 * supported for WebM.`。默认输出路径曾直接沿用源文件扩展名，yt-dlp 下载的 .webm 因此
 * 无法烧录硬字幕（#521）。
 *
 * 黑名单只收 ffmpeg 6.0 实测会拒绝 H.264 的 .webm / .ogv / .ogg；其余扩展名的行为保持不变。
 */

/** ffmpeg 6.0 实测会拒绝 H.264/AAC 的容器扩展名（小写，含点）。 */
const UNWRITABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.webm',
  '.ogv',
  '.ogg',
]);

/** MP4 系容器：QuickTime、移动端、剪辑软件与平台上传对其音频编码要求严格。 */
const MP4_FAMILY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4',
  '.m4v',
  '.mov',
]);

/**
 * 默认回退容器：硬烧交付物以 MP4 兼容性最好。想改成 MKV 只需改这一个常量
 * （MKV 接受任意音频，届时无需任何音频转码规则）。
 */
export const FALLBACK_COMPOSE_EXTENSION = '.mp4';

/** 统一为小写、带点的写法；调用方可能传 `.webm` 或 `webm`。 */
function normalizeExtension(extension: string): string {
  const lower = extension.toLowerCase();
  return lower && !lower.startsWith('.') ? `.${lower}` : lower;
}

/**
 * 文件名最后一段的扩展名（含点，保留原大小写）；目录名里的点不算。
 * 与 ffmpeg 按输出文件名后缀选择 muxer 的口径一致。
 */
function extensionOf(filePath: string): string {
  return /(\.[^./\\]+)$/.exec(filePath)?.[1] ?? '';
}

/** 该扩展名的容器能否容纳合成引擎写出的 H.264/AAC。 */
export function isComposeContainerWritable(extension: string): boolean {
  return !UNWRITABLE_EXTENSIONS.has(normalizeExtension(extension));
}

/**
 * 默认输出扩展名：沿用源容器；写不下 H.264/AAC 的（WebM/Ogg）回落 MP4。
 * 可写的扩展名原样返回（保留大小写）。
 */
export function writableComposeExtension(extension: string): string {
  return isComposeContainerWritable(extension)
    ? extension
    : FALLBACK_COMPOSE_EXTENSION;
}

/**
 * 引擎入口防护：输出路径的容器写不下 H.264/AAC 时直接抛出可读错误，
 * 而不是等 ffmpeg 写头失败后只剩一句 `Conversion failed!`。
 */
export function assertComposeOutputWritable(outputPath: string): void {
  const extension = extensionOf(outputPath);
  if (isComposeContainerWritable(extension)) return;
  throw new Error(
    `Output container "${extension}" cannot hold the H.264/AAC streams a compose job writes ` +
      '(WebM/Ogg only accept VP8/VP9/AV1 video with Vorbis/Opus audio); choose an .mp4 or .mkv output',
  );
}

/**
 * 硬烧保留原音轨时，音频是否要转 AAC：WebM/Ogg 源的音频是 Opus/Vorbis，ffmpeg 能直拷进 MP4，
 * 但 QuickTime、剪辑软件、平台上传兼容差（.mov/.m4v 甚至直拷失败），所以写入 MP4 系输出时转 AAC。
 * 其余组合（含用户手动选的 .mkv）保持直拷。
 */
export function sourceAudioNeedsAac(
  sourceExtension: string,
  outputExtension: string,
): boolean {
  return (
    !isComposeContainerWritable(sourceExtension) &&
    MP4_FAMILY_EXTENSIONS.has(normalizeExtension(outputExtension))
  );
}
