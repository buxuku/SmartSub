/**
 * 配对模式（视频+字幕混合输入）的同名配对纯函数：向导与单测共用。
 *
 * 规则：按文件名主干（去扩展名）匹配——字幕主干与视频主干完全一致优先；
 * 其次接受「视频主干 + '.'」前缀（如 foo.zh.srt ↔ foo.mp4，覆盖本应用
 * 交付物与常见语言后缀命名）。每个字幕至多配一个视频；.txt 字幕不参与
 * 配对（烧录/配音均不可用）。
 */

export interface PairableFile {
  filePath: string;
  /** 去扩展名的文件名主干（wrapFileObject 语义） */
  fileName: string;
}

export interface PairingResult<M extends PairableFile, S extends PairableFile> {
  /** 视频 → 配对字幕（保持 media 原顺序） */
  pairs: Array<{ media: M; subtitle: S }>;
  unpairedMedia: M[];
  unpairedSubtitles: S[];
}

function isPlainTextPath(p: string): boolean {
  return /\.txt$/i.test(p);
}

export function pairMediaWithSubtitles<
  M extends PairableFile,
  S extends PairableFile,
>(mediaFiles: M[], subtitleFiles: S[]): PairingResult<M, S> {
  const usable = subtitleFiles.filter((s) => !isPlainTextPath(s.filePath));
  const txtSubtitles = subtitleFiles.filter((s) => isPlainTextPath(s.filePath));
  const taken = new Set<S>();
  const pairs: Array<{ media: M; subtitle: S }> = [];
  const unpairedMedia: M[] = [];

  for (const media of mediaFiles) {
    const exact = usable.find(
      (s) => !taken.has(s) && s.fileName === media.fileName,
    );
    // 前缀候选按主干排序，保证多语言后缀时选取确定（foo.en < foo.zh）
    const prefix = exact
      ? undefined
      : usable
          .filter(
            (s) => !taken.has(s) && s.fileName.startsWith(`${media.fileName}.`),
          )
          .sort((a, b) => a.fileName.localeCompare(b.fileName))[0];
    const hit = exact ?? prefix;
    if (hit) {
      taken.add(hit);
      pairs.push({ media, subtitle: hit });
    } else {
      unpairedMedia.push(media);
    }
  }

  return {
    pairs,
    unpairedMedia,
    unpairedSubtitles: [
      ...usable.filter((s) => !taken.has(s)),
      ...txtSubtitles,
    ],
  };
}
