import type { BinaryDownloadSource } from '../downloadSourceOrder';

/** 同一发布物在 GitHub 与 GitCode 上的仓库 slug 往往不同，必须分开声明。 */
export interface ReleaseRepoSlugs {
  github: string;
  gitcode: string;
}

/**
 * 统一解析某下载源下的 release 基础 URL（不含末尾斜杠）。
 * - github:  https://github.com/{slugs.github}/releases/download/{tag}
 * - ghproxy: https://ghfast.top/<github url>
 * - gitcode: https://gitcode.com/{slugs.gitcode}/releases/download/{tag}
 */
export function resolveReleaseBaseUrl(
  source: BinaryDownloadSource,
  slugs: ReleaseRepoSlugs,
  tag: string,
): string {
  if (source === 'gitcode') {
    return `https://gitcode.com/${slugs.gitcode}/releases/download/${tag}`;
  }
  const github = `https://github.com/${slugs.github}/releases/download/${tag}`;
  return source === 'ghproxy' ? `https://ghfast.top/${github}` : github;
}
