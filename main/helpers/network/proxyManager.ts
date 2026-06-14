import * as https from 'https';
import { bootstrap } from 'global-agent';
import { store } from '../store';
import { logMessage } from '../storeManager';
import { resolveProxyEnv, type ProxySettings } from './proxyEnv';

export type { ProxySettings, ProxyEnv } from './proxyEnv';
export { resolveProxyEnv } from './proxyEnv';

interface GlobalAgentConfig {
  HTTP_PROXY: string;
  HTTPS_PROXY: string;
  NO_PROXY: string;
}

function getGlobalAgent(): GlobalAgentConfig | undefined {
  return (global as unknown as { GLOBAL_AGENT?: GlobalAgentConfig })
    .GLOBAL_AGENT;
}

let bootstrapped = false;

/** 进程内只调用一次 global-agent bootstrap（幂等）。须在任何联网前执行。 */
export function bootstrapProxy(): void {
  if (bootstrapped) return;
  // 不通过 env 前缀自动注入，统一由 applyProxyFromSettings 显式写 global 配置
  bootstrap();
  bootstrapped = true;
}

/** 按当前 settings 写入 global-agent 运行时配置；空字符串=直连。改完即时生效。 */
export function applyProxyFromSettings(): void {
  const settings = store.get('settings') as ProxySettings | undefined;
  const { httpProxy, noProxy } = resolveProxyEnv(settings || {});

  // process.env 兜底（部分库读 env）；global-agent 运行时读 global.GLOBAL_AGENT
  process.env.GLOBAL_AGENT_HTTP_PROXY = httpProxy;
  process.env.GLOBAL_AGENT_HTTPS_PROXY = httpProxy;
  process.env.GLOBAL_AGENT_NO_PROXY = noProxy;

  const ga = getGlobalAgent();
  if (ga) {
    ga.HTTP_PROXY = httpProxy;
    ga.HTTPS_PROXY = httpProxy;
    ga.NO_PROXY = noProxy;
  }

  logMessage(
    `proxy applied: ${httpProxy ? `custom ${httpProxy}` : 'none (direct)'}`,
    'info',
  );
}

export interface ProxyTestResult {
  ok: boolean;
  ms: number;
  status?: number;
  error?: string;
}

/** 经当前 global agent 向轻量端点发请求，回报连通性。 */
export function testProxyConnectivity(
  testUrl = 'https://www.gstatic.com/generate_204',
): Promise<ProxyTestResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = https.get(
      testUrl,
      { headers: { 'User-Agent': 'SmartSub-Electron' }, timeout: 8000 },
      (res) => {
        const ms = Date.now() - startedAt;
        res.resume(); // 释放 socket
        resolve({ ok: true, ms, status: res.statusCode });
      },
    );
    req.on('error', (err) => {
      resolve({
        ok: false,
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, ms: Date.now() - startedAt, error: 'timeout' });
    });
  });
}
