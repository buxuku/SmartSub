import * as http from 'http';
import * as https from 'https';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;

export interface FetchJsonOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
  cancelMessage?: string;
}

/**
 * 获取 JSON，支持有限重定向、连接超时与 AbortSignal。
 * 每次重定向继续沿用同一个 signal，避免取消窗口落在重定向/文件树请求期间时失效。
 */
export function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
  redirects = 0,
): Promise<T> {
  const {
    signal,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    cancelMessage = 'Download cancelled',
  } = options;

  if (signal?.aborted) {
    return Promise.reject(new Error(cancelMessage));
  }

  return new Promise<T>((resolve, reject) => {
    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    let request: http.ClientRequest;

    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      const error = new Error(cancelMessage);
      request.destroy(error);
      fail(error);
    };

    request = protocol.get(url, { headers }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= maxRedirects) {
          fail(new Error('Too many redirects while fetching JSON'));
          return;
        }
        settled = true;
        cleanup();
        fetchJson<T>(
          new URL(response.headers.location, url).href,
          options,
          redirects + 1,
        ).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        fail(new Error(`HTTP Error: ${status}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('aborted', () =>
        fail(new Error('JSON response aborted before completion')),
      );
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        try {
          succeed(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch (error) {
          fail(error);
        }
      });
    });

    request.on('error', fail);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('JSON request timeout'));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
