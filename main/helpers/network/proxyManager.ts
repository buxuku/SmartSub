import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import { once } from 'events';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { store } from '../store';
import { logMessage } from '../storeManager';
import { resolveProxyEnv, type ProxySettings } from './proxyEnv';

export type { ProxySettings, ProxyEnv } from './proxyEnv';
export { resolveProxyEnv } from './proxyEnv';

// 原始（直连）globalAgent，切回 none 时还原
const ORIGINAL_HTTP_AGENT = http.globalAgent;
const ORIGINAL_HTTPS_AGENT = https.globalAgent;

/** host 是否命中 NO_PROXY 列表（精确或子域匹配），命中则直连绕过代理。 */
function hostInNoProxy(host: string | undefined, noProxy: string): boolean {
  if (!host || !noProxy) return false;
  const list = noProxy
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const h = String(host).toLowerCase();
  return list.some((e) => h === e || h.endsWith('.' + e));
}

// 复用库的精确类型，保证 override 签名与父类一致
type HttpsConnect = HttpsProxyAgent<string>['connect'];
type HttpsConnectReq = Parameters<HttpsConnect>[0];
type HttpsConnectOpts = Parameters<HttpsConnect>[1];
type HttpConnect = HttpProxyAgent<string>['connect'];
type HttpAddReq = Parameters<HttpProxyAgent<string>['addRequest']>[0];

interface ConnectTarget {
  host?: string;
  port?: number;
  servername?: string;
  secureEndpoint?: boolean;
}

/**
 * https 目标的代理 Agent：子类化 HttpsProxyAgent，仅在 NO_PROXY 命中时直连，
 * 其余沿用库的 CONNECT 隧道 + TLS 升级逻辑（避免重新实现易错的隧道）。
 */
class NoProxyHttpsAgent extends HttpsProxyAgent<string> {
  private noProxy: string;
  constructor(proxy: string, noProxy: string) {
    super(proxy);
    this.noProxy = noProxy;
  }
  async connect(
    req: HttpsConnectReq,
    opts: HttpsConnectOpts,
  ): ReturnType<HttpsConnect> {
    const t = opts as ConnectTarget;
    if (hostInNoProxy(t.host, this.noProxy)) {
      if (t.secureEndpoint) {
        const servername =
          t.servername || (net.isIP(t.host || '') ? undefined : t.host);
        return tls.connect({ host: t.host, port: t.port, servername });
      }
      return net.connect({ host: t.host, port: t.port });
    }
    return super.connect(req, opts);
  }
}

/**
 * http 目标的代理 Agent：子类化 HttpProxyAgent。NO_PROXY 命中时退回普通
 * http.Agent 行为（不改写 req.path 为绝对 URL，直连目标）。
 */
class NoProxyHttpAgent extends HttpProxyAgent<string> {
  private noProxy: string;
  constructor(proxy: string, noProxy: string) {
    super(proxy);
    this.noProxy = noProxy;
  }
  addRequest(
    req: HttpAddReq,
    opts: Parameters<HttpProxyAgent<string>['addRequest']>[1],
  ): void {
    const t = opts as ConnectTarget;
    if (hostInNoProxy(t.host, this.noProxy)) {
      (
        http.Agent.prototype.addRequest as unknown as (
          r: HttpAddReq,
          o: unknown,
        ) => void
      ).call(this, req, opts);
      return;
    }
    super.addRequest(req, opts);
  }
  async connect(
    req: Parameters<HttpConnect>[0],
    opts: Parameters<HttpConnect>[1],
  ): ReturnType<HttpConnect> {
    const t = opts as ConnectTarget;
    if (hostInNoProxy(t.host, this.noProxy)) {
      const socket = net.connect({ host: t.host, port: t.port });
      await once(socket, 'connect');
      return socket;
    }
    return super.connect(req, opts);
  }
}

let activeProxyUrl = '';

/** 当前生效的代理地址（空串=直连）。用于诊断/日志。 */
export function getActiveProxyUrl(): string {
  return activeProxyUrl;
}

/**
 * 按当前 settings 重建并安装全局 Agent。
 * - custom 且有 url：http/https.globalAgent 切换为带 NO_PROXY 绕过的代理 Agent。
 * - none/空：还原为原始直连 Agent。
 * 改完即时生效（下次请求读取 globalAgent）。
 */
export function applyProxyFromSettings(): void {
  const settings = store.get('settings') as ProxySettings | undefined;
  const { httpProxy, noProxy } = resolveProxyEnv(settings || {});

  if (httpProxy) {
    http.globalAgent = new NoProxyHttpAgent(
      httpProxy,
      noProxy,
    ) as unknown as http.Agent;
    https.globalAgent = new NoProxyHttpsAgent(
      httpProxy,
      noProxy,
    ) as unknown as https.Agent;
  } else {
    http.globalAgent = ORIGINAL_HTTP_AGENT;
    https.globalAgent = ORIGINAL_HTTPS_AGENT;
  }

  activeProxyUrl = httpProxy;
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
