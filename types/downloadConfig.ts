/**
 * 下载源端点（镜像 / 代理）配置。
 *
 * 集中管理所有「可被用户覆盖」的下载基础地址，作为单一来源（single source of
 * truth）：main 进程各 downloader 统一从此读取，renderer 设置页统一编辑，避免镜像 /
 * 代理地址散落在各处硬编码、改一处不够、还要发版的问题。
 *
 * 本文件必须保持「纯 TS、无 electron/node 副作用」，以便 renderer 也能直接 import。
 */
export interface DownloadEndpointConfig {
  /** GitHub 站点 base（含协议、无末尾斜杠），如 https://github.com */
  githubBase: string;
  /** GitHub 代理前缀（含协议、无末尾斜杠），拼接时自动补 /，如 https://gh-proxy.com */
  githubProxyPrefix: string;
  /** GitCode 站点 base（含协议、无末尾斜杠），如 https://gitcode.com */
  gitcodeBase: string;
  /** HuggingFace 国内镜像 base（含协议、无末尾斜杠），如 https://hf-mirror.com */
  huggingFaceMirror: string;
  /** HuggingFace 官方 base（含协议、无末尾斜杠），如 https://huggingface.co */
  huggingFaceOfficial: string;
  /** ModelScope 站点 base（含协议、无末尾斜杠），如 https://modelscope.cn */
  modelScopeBase: string;
}

export const DEFAULT_DOWNLOAD_ENDPOINTS: DownloadEndpointConfig = {
  githubBase: 'https://github.com',
  githubProxyPrefix: 'https://gh-proxy.com',
  gitcodeBase: 'https://gitcode.com',
  huggingFaceMirror: 'https://hf-mirror.com',
  huggingFaceOfficial: 'https://huggingface.co',
  modelScopeBase: 'https://modelscope.cn',
};

/**
 * P0 阶段在设置页暴露给用户编辑的字段（其余字段保留默认值，便于未来扩展）。
 * 顺序即设置页展示顺序。
 */
export const EDITABLE_DOWNLOAD_ENDPOINT_KEYS: (keyof DownloadEndpointConfig)[] =
  ['githubProxyPrefix', 'huggingFaceMirror', 'modelScopeBase', 'gitcodeBase'];

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** base：含协议、无末尾斜杠；缺协议自动补 https://；空回退默认。 */
function normalizeBase(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  let v = value.trim();
  if (!v) return fallback;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  v = stripTrailingSlash(v);
  return v || fallback;
}

/**
 * 将用户覆盖（可能为部分字段 / 空值 / 非法值）与默认值合并为一份完整、规范的配置。
 * 任何缺失或非法字段都会回退到对应默认值，保证下游永远拿到可用地址。
 */
export function normalizeDownloadEndpoints(
  raw: Partial<DownloadEndpointConfig> | undefined | null,
): DownloadEndpointConfig {
  const r = raw ?? {};
  return {
    githubBase: normalizeBase(
      r.githubBase,
      DEFAULT_DOWNLOAD_ENDPOINTS.githubBase,
    ),
    githubProxyPrefix: normalizeBase(
      r.githubProxyPrefix,
      DEFAULT_DOWNLOAD_ENDPOINTS.githubProxyPrefix,
    ),
    gitcodeBase: normalizeBase(
      r.gitcodeBase,
      DEFAULT_DOWNLOAD_ENDPOINTS.gitcodeBase,
    ),
    huggingFaceMirror: normalizeBase(
      r.huggingFaceMirror,
      DEFAULT_DOWNLOAD_ENDPOINTS.huggingFaceMirror,
    ),
    huggingFaceOfficial: normalizeBase(
      r.huggingFaceOfficial,
      DEFAULT_DOWNLOAD_ENDPOINTS.huggingFaceOfficial,
    ),
    modelScopeBase: normalizeBase(
      r.modelScopeBase,
      DEFAULT_DOWNLOAD_ENDPOINTS.modelScopeBase,
    ),
  };
}
