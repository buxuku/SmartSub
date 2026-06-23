import { useEffect, useState } from 'react';
import {
  DEFAULT_DOWNLOAD_ENDPOINTS,
  normalizeDownloadEndpoints,
  type DownloadEndpointConfig,
} from '../../types/downloadConfig';

/**
 * 读取「当前生效的下载端点配置」（用户在设置页的覆盖 + 默认值规范化）。
 *
 * 仅用于 renderer 侧展示用途（如「复制下载链接」），让复制出的镜像地址与用户配置一致。
 * 通过模块级缓存保证：无论挂载多少行，整个会话只发一次 getSettings IPC。
 */
let cache: DownloadEndpointConfig | null = null;
let inflight: Promise<DownloadEndpointConfig> | null = null;

/** 设置页保存 / 重置下载端点后调用，使缓存失效，下次挂载即读取最新配置。 */
export function invalidateDownloadEndpointsCache(): void {
  cache = null;
  inflight = null;
}

async function loadEndpoints(): Promise<DownloadEndpointConfig> {
  if (cache) return cache;
  if (!inflight) {
    inflight = (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        cache = normalizeDownloadEndpoints(settings?.downloadEndpoints);
      } catch {
        cache = { ...DEFAULT_DOWNLOAD_ENDPOINTS };
      }
      return cache;
    })();
  }
  return inflight;
}

export default function useDownloadEndpoints(): DownloadEndpointConfig {
  const [endpoints, setEndpoints] = useState<DownloadEndpointConfig>(
    cache ?? DEFAULT_DOWNLOAD_ENDPOINTS,
  );

  useEffect(() => {
    let mounted = true;
    if (cache) {
      setEndpoints(cache);
      return;
    }
    void loadEndpoints().then((ep) => {
      if (mounted) setEndpoints(ep);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return endpoints;
}
