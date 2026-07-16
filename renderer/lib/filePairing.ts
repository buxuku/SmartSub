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

/**
 * 带手动指派的配对：manualPairs（媒体路径 → 字幕路径）优先生效，
 * 未指派的媒体在剩余字幕池里按同名规则自动配对——覆盖字幕名与视频名
 * 不一致的场景（如 demo.mp4 ↔ demo_1.srt）。
 * 手动指派做兜底校验：字幕须仍在列表中、txt 拒绝、同一字幕被多条手动
 * 指派引用时按媒体顺序先到先得（调用方 setter 应保证唯一）。
 */
export function pairMediaWithSubtitlesManual<
  M extends PairableFile,
  S extends PairableFile,
>(
  mediaFiles: M[],
  subtitleFiles: S[],
  manualPairs: ReadonlyMap<string, string>,
): PairingResult<M, S> {
  const subtitleByPath = new Map(subtitleFiles.map((s) => [s.filePath, s]));
  const manualTaken = new Set<string>();
  const manualByMedia = new Map<string, S>();
  const autoMedia: M[] = [];

  for (const media of mediaFiles) {
    const manualPath = manualPairs.get(media.filePath);
    const subtitle = manualPath ? subtitleByPath.get(manualPath) : undefined;
    if (
      subtitle &&
      !isPlainTextPath(subtitle.filePath) &&
      !manualTaken.has(subtitle.filePath)
    ) {
      manualTaken.add(subtitle.filePath);
      manualByMedia.set(media.filePath, subtitle);
    } else {
      autoMedia.push(media);
    }
  }

  const auto = pairMediaWithSubtitles(
    autoMedia,
    subtitleFiles.filter((s) => !manualTaken.has(s.filePath)),
  );
  const autoByMedia = new Map(
    auto.pairs.map((p) => [p.media.filePath, p.subtitle]),
  );

  const pairs: Array<{ media: M; subtitle: S }> = [];
  const unpairedMedia: M[] = [];
  for (const media of mediaFiles) {
    const subtitle =
      manualByMedia.get(media.filePath) ?? autoByMedia.get(media.filePath);
    if (subtitle) pairs.push({ media, subtitle });
    else unpairedMedia.push(media);
  }
  const taken = new Set(pairs.map((p) => p.subtitle.filePath));
  return {
    pairs,
    unpairedMedia,
    unpairedSubtitles: subtitleFiles.filter((s) => !taken.has(s.filePath)),
  };
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
