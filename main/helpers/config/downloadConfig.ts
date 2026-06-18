import { store } from '../store';
import {
  DownloadEndpointConfig,
  normalizeDownloadEndpoints,
} from '../../../types/downloadConfig';

export type { DownloadEndpointConfig } from '../../../types/downloadConfig';
export {
  DEFAULT_DOWNLOAD_ENDPOINTS,
  EDITABLE_DOWNLOAD_ENDPOINT_KEYS,
  normalizeDownloadEndpoints,
} from '../../../types/downloadConfig';

/**
 * 实时读取当前生效的下载端点配置（store 用户覆盖 + 默认值合并）。
 * 每次调用都重新读取，因此用户在设置页改完即时生效，无需重启 / 发版。
 */
export function getDownloadEndpoints(): DownloadEndpointConfig {
  let raw: Partial<DownloadEndpointConfig> | undefined;
  try {
    const settings = store.get('settings') as
      | { downloadEndpoints?: Partial<DownloadEndpointConfig> }
      | undefined;
    raw = settings?.downloadEndpoints;
  } catch {
    raw = undefined;
  }
  return normalizeDownloadEndpoints(raw);
}

export function getGithubBase(): string {
  return getDownloadEndpoints().githubBase;
}

export function getGithubProxyPrefix(): string {
  return getDownloadEndpoints().githubProxyPrefix;
}

export function getGitcodeBase(): string {
  return getDownloadEndpoints().gitcodeBase;
}

export function getModelScopeBase(): string {
  return getDownloadEndpoints().modelScopeBase;
}

/**
 * 解析 HuggingFace host：source==='huggingface' 用官方，否则用国内镜像。
 * 保持既有各 downloader 的语义（默认走镜像）。
 */
export function getHfHost(source?: string): string {
  const ep = getDownloadEndpoints();
  return source === 'huggingface'
    ? ep.huggingFaceOfficial
    : ep.huggingFaceMirror;
}

/**
 * HuggingFace host 回退序列：source==='huggingface' 官方优先，否则镜像优先。
 * 供需要按序回退多个 host 的 downloader（如 funasr）使用。
 */
export function getHfHosts(source?: string): string[] {
  const ep = getDownloadEndpoints();
  return source === 'huggingface'
    ? [ep.huggingFaceOfficial, ep.huggingFaceMirror]
    : [ep.huggingFaceMirror, ep.huggingFaceOfficial];
}

/** 用当前配置的代理前缀包裹一个完整 github url（前缀与 url 间自动补 /）。 */
export function wrapGithubProxy(githubUrl: string): string {
  return `${getGithubProxyPrefix()}/${githubUrl}`;
}
