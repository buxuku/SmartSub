import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
export const SINGLE_DOWNLOAD_CANCELLED = 'Download cancelled';

export interface SingleFileDownloadOptions {
  url: string;
  destPath: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
  onProgress?: (downloaded: number, total: number) => void;
}

function redirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).href;
}

/**
 * 单连接下载回退。以 socket inactivity timeout 约束连接和响应停滞，只有在
 * HTTP 消息完整、Content-Length（若提供）匹配且写流正常 close 后才算成功。
 */
export function downloadFileSingle(
  options: SingleFileDownloadOptions,
  redirectCount = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const {
      url,
      destPath,
      signal,
      headers = {},
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxRedirects = DEFAULT_MAX_REDIRECTS,
      onProgress,
    } = options;

    if (signal?.aborted) {
      reject(new Error(SINGLE_DOWNLOAD_CANCELLED));
      return;
    }

    let settled = false;
    let response: http.IncomingMessage | null = null;
    let output: fs.WriteStream | null = null;
    let request: http.ClientRequest | null = null;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      output?.destroy();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      request?.destroy();
      fail(new Error(SINGLE_DOWNLOAD_CANCELLED));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;
    request = protocol.get(url, { headers }, (incoming) => {
      response = incoming;
      const status = incoming.statusCode ?? 0;

      if (status >= 300 && status < 400 && incoming.headers.location) {
        if (redirectCount >= maxRedirects) {
          incoming.resume();
          fail(new Error('Too many redirects'));
          return;
        }
        settled = true;
        cleanup();
        incoming.resume();
        downloadFileSingle(
          {
            ...options,
            url: redirectUrl(url, incoming.headers.location),
          },
          redirectCount + 1,
        )
          .then(resolve)
          .catch(reject);
        return;
      }

      if (status < 200 || status >= 300) {
        incoming.resume();
        fail(new Error(`HTTP Error: ${status}`));
        return;
      }

      const total = Number(incoming.headers['content-length'] || 0);
      let downloaded = 0;
      let responseEnded = false;
      let writeFinished = false;

      incoming.on('aborted', () =>
        fail(new Error('Download response aborted before completion')),
      );
      incoming.on('error', (error) =>
        fail(error instanceof Error ? error : new Error(String(error))),
      );
      incoming.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        onProgress?.(downloaded, total);
      });
      incoming.on('end', () => {
        responseEnded = true;
      });

      output = fs.createWriteStream(destPath, { flags: 'w' });
      output.on('error', (error) =>
        fail(error instanceof Error ? error : new Error(String(error))),
      );
      output.on('finish', () => {
        if (!responseEnded || !incoming.complete) {
          fail(new Error('Download response ended before completion'));
          return;
        }
        if (total > 0 && downloaded !== total) {
          fail(
            new Error(
              `Download size mismatch: got ${downloaded}, expected ${total}`,
            ),
          );
          return;
        }
        writeFinished = true;
      });
      output.on('close', () => {
        if (!writeFinished) {
          fail(new Error('Download output closed before completion'));
          return;
        }
        succeed();
      });
      incoming.pipe(output);
    });

    request.on('error', (error) => {
      if (signal?.aborted) {
        fail(new Error(SINGLE_DOWNLOAD_CANCELLED));
        return;
      }
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.setTimeout(timeoutMs, () => {
      request?.destroy();
      fail(new Error(`Download timed out after ${timeoutMs}ms`));
    });
  });
}
