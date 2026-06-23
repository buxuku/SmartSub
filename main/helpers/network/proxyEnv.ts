/**
 * 代理设置 → global-agent 运行时配置的纯映射逻辑。
 * 单独成文件、不引入 Electron/store，便于在 node 单测中直接引用。
 */

export interface ProxySettings {
  proxyMode?: 'none' | 'custom';
  proxyUrl?: string;
  proxyNoProxy?: string;
}

export interface ProxyEnv {
  httpProxy: string;
  noProxy: string;
}

export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1';

/**
 * 纯函数：把代理设置映射为 global-agent 需要的 {httpProxy, noProxy}。
 * none / 缺失 / custom 但无 URL → 全空（等于关闭代理）。
 */
export function resolveProxyEnv(settings: ProxySettings): ProxyEnv {
  const url = (settings?.proxyUrl || '').trim();
  if (settings?.proxyMode === 'custom' && url) {
    const noProxy = (settings.proxyNoProxy || DEFAULT_NO_PROXY).trim();
    return { httpProxy: url, noProxy };
  }
  return { httpProxy: '', noProxy: '' };
}
