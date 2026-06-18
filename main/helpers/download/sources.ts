import type { BinaryDownloadSource } from '../downloadSourceOrder';
import {
  getGithubBase,
  getGitcodeBase,
  getGithubProxyPrefix,
} from '../config/downloadConfig';

/** 同一发布物在 GitHub 与 GitCode 上的仓库 slug 往往不同，必须分开声明。 */
export interface ReleaseRepoSlugs {
  github: string;
  gitcode: string;
}

/**
 * 统一解析某下载源下的 release 基础 URL（不含末尾斜杠）。
 * 各源 base / 代理前缀均来自可配置的下载端点（用户可在设置页覆盖）。
 * - github:  {githubBase}/{slugs.github}/releases/download/{tag}
 * - ghproxy: {githubProxyPrefix}/{github url}
 * - gitcode: {gitcodeBase}/{slugs.gitcode}/releases/download/{tag}
 */
export function resolveReleaseBaseUrl(
  source: BinaryDownloadSource,
  slugs: ReleaseRepoSlugs,
  tag: string,
): string {
  if (source === 'gitcode') {
    return `${getGitcodeBase()}/${slugs.gitcode}/releases/download/${tag}`;
  }
  const github = `${getGithubBase()}/${slugs.github}/releases/download/${tag}`;
  return source === 'ghproxy' ? `${getGithubProxyPrefix()}/${github}` : github;
}
