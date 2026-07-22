/**
 * Cookie 导入编排：文件 / 粘贴原始串 / 从浏览器提取（以 yt-dlp 为提取器）。
 * 解析与过滤落盘复用 cookieProfileStore.importCookiesToProfile。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logMessage } from '../storeManager';
import { getDownloaderBinaryPath } from '../downloaderManager';
import { runProcess } from './engineAdapter';
import { tailForError } from './parsers';
import {
  getProfileCookieDomains,
  importCookiesToProfile,
  type ImportResult,
} from './cookieProfileStore';
import {
  cookiesFromRawString,
  parseNetscapeCookies,
  filterCookiesByDomains,
} from './cookies';
import type { CookieProfileSource } from '../../../types/download';

/** 浏览器提取超时（含 macOS 钥匙串授权弹窗等待，给足） */
const BROWSER_EXTRACT_TIMEOUT_MS = 180_000;
/** 提取用 dummy URL：连接秒败、零外网请求，仅触发 cookie jar 写出 */
const DUMMY_URL = 'http://127.0.0.1:0/';

export type SupportedBrowser =
  | 'chrome'
  | 'edge'
  | 'firefox'
  | 'safari'
  | 'brave';

interface CustomDef {
  name: string;
  matchDomains: string[];
  cookieDomains: string[];
}

/** 文件导入：读入 Netscape 文本 → 过滤落盘 */
export function importCookiesFromFile(params: {
  id: string;
  filePath: string;
  customDef?: CustomDef;
}): ImportResult {
  const text = fs.readFileSync(params.filePath, 'utf8');
  const cookies = parseNetscapeCookies(text);
  if (cookies.length === 0) {
    throw new Error('No valid Netscape cookies found in file');
  }
  return importCookiesToProfile({
    id: params.id,
    cookies,
    source: 'file',
    customDef: params.customDef,
  });
}

/** 粘贴导入：原始 Cookie 串按档案主域合成 Netscape 行 → 过滤落盘 */
export function importCookiesFromPaste(params: {
  id: string;
  raw: string;
  customDef?: CustomDef;
}): ImportResult {
  const domains = getProfileCookieDomains(params.id, params.customDef);
  const primaryDomain = domains[0];
  if (!primaryDomain) {
    throw new Error('Profile has no cookie domain to synthesize cookies');
  }
  const cookies = cookiesFromRawString(params.raw, primaryDomain);
  if (cookies.length === 0) {
    throw new Error('No valid name=value pairs in pasted cookie string');
  }
  return importCookiesToProfile({
    id: params.id,
    cookies,
    source: 'paste',
    customDef: params.customDef,
  });
}

/**
 * 从浏览器提取：yt-dlp `--cookies-from-browser` 导出 Netscape 文件，
 * 过滤出目标域后落盘。成功判据为「输出文件存在且过滤后含 cookie」（不看退出码——
 * yt-dlp 提取 dummy URL 必然失败退出，但 cookie jar 已在退出前写出）。
 */
export async function importCookiesFromBrowser(params: {
  id: string;
  browser: SupportedBrowser;
  customDef?: CustomDef;
}): Promise<ImportResult> {
  const binaryPath = getDownloaderBinaryPath('yt-dlp');
  if (!binaryPath) {
    throw new Error('YTDLP_NOT_INSTALLED');
  }
  const outPath = path.join(
    os.tmpdir(),
    `smartsub-cookie-extract-${uuidv4()}.txt`,
  );
  const args = [
    '--cookies-from-browser',
    params.browser,
    '--cookies',
    outPath,
    '--skip-download',
    '--no-warnings',
    '--',
    DUMMY_URL,
  ];
  let result: Awaited<ReturnType<typeof runProcess>> | null = null;
  try {
    result = await runProcess(binaryPath, args, {
      timeoutMs: BROWSER_EXTRACT_TIMEOUT_MS,
    });
  } catch (error) {
    // 超时等 spawn 级错误：清理后抛出
    safeUnlink(outPath);
    throw error;
  }

  try {
    if (!fs.existsSync(outPath)) {
      const detail = tailForError(result.stderr || result.stdout);
      throw new Error(
        `Browser cookie extraction produced no file${detail ? `: ${detail}` : ''}`,
      );
    }
    const text = fs.readFileSync(outPath, 'utf8');
    const cookies = parseNetscapeCookies(text);
    const domains = getProfileCookieDomains(params.id, params.customDef);
    const matched = filterCookiesByDomains(cookies, domains);
    if (matched.length === 0) {
      const detail = tailForError(result.stderr || result.stdout);
      throw new Error(
        `No ${domains.join('/')} cookies found in ${params.browser}${detail ? `: ${detail}` : ''}`,
      );
    }
    return importCookiesToProfile({
      id: params.id,
      cookies,
      source: 'browser',
      customDef: params.customDef,
    });
  } finally {
    safeUnlink(outPath);
  }
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  } catch (error) {
    logMessage(`cookie extract temp cleanup failed: ${error}`, 'warning');
  }
}
