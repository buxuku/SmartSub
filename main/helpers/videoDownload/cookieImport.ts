/**
 * Cookie 导入编排：文件 / 粘贴原始串 / 从浏览器提取（以 yt-dlp 为提取器）。
 * 解析与过滤落盘复用 cookieProfileStore.importCookiesToProfile。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logMessage } from '../storeManager';
import { getDownloaderBinaryPath } from '../downloaderManager';
import { runProcess } from './engineAdapter';
import {
  listBrowserCookieProfiles,
  prepareBrowserCookieSource,
} from './browserCookieSource';
import { tailForError } from './parsers';
import {
  getProfileCookieDomains,
  importCookiesToProfile,
  importCookiesForSites,
  type ImportResult,
} from './cookieProfileStore';
import {
  cookiesFromRawString,
  parseNetscapeCookies,
  filterCookiesByDomains,
  type NetscapeCookie,
} from './cookies';
import {
  COOKIE_BROWSERS,
  type CookieBrowser,
  type CookieBatchImportResult,
} from '../../../types/download';

/** 浏览器提取超时（含 macOS 钥匙串授权弹窗等待，给足） */
const BROWSER_EXTRACT_TIMEOUT_MS = 180_000;
/** 提取用 dummy URL：连接秒败、零外网请求，仅触发 cookie jar 写出 */
const DUMMY_URL = 'http://127.0.0.1:0/';

export const SUPPORTED_BROWSERS = COOKIE_BROWSERS;
export type SupportedBrowser = CookieBrowser;

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

interface BrowserImportParams {
  browser: SupportedBrowser;
  browserProfile?: string;
}

export function importAllCookiesFromFile(params: {
  filePath: string;
}): CookieBatchImportResult {
  const cookies = parseNetscapeCookies(
    fs.readFileSync(params.filePath, 'utf8'),
  );
  if (!cookies.length) throw new Error('NO_VALID_COOKIES');
  return importCookiesForSites({ cookies, source: 'file' });
}

export async function importAllCookiesFromBrowser(
  params: BrowserImportParams,
): Promise<CookieBatchImportResult> {
  const { cookies, browserProfile } = await extractBrowserCookies(params);
  return importCookiesForSites({
    cookies,
    source: 'browser',
    browser: params.browser,
    browserProfile,
  });
}

export async function importCookiesFromBrowser(
  params: BrowserImportParams & {
    id: string;
    customDef?: CustomDef;
  },
): Promise<ImportResult> {
  const { cookies, browserProfile } = await extractBrowserCookies(params);
  const domains = getProfileCookieDomains(params.id, params.customDef);
  if (!filterCookiesByDomains(cookies, domains).length) {
    throw new Error(
      `No ${domains.join('/')} cookies found in ${params.browser}. Check the site domain and the signed-in browser profile, or import a cookies.txt file.`,
    );
  }
  return importCookiesToProfile({
    id: params.id,
    cookies,
    source: 'browser',
    browser: params.browser,
    browserProfile,
    customDef: params.customDef,
  });
}

/** 一次导出，立即清理全量文件，再由调用者过滤并保存站点数据。 */
async function extractBrowserCookies(params: BrowserImportParams): Promise<{
  cookies: NetscapeCookie[];
  browserProfile?: string;
}> {
  // 运行时白名单：browser 来自渲染进程，直接拼进 yt-dlp 参数，类型标注不设防
  if (!(SUPPORTED_BROWSERS as readonly string[]).includes(params.browser)) {
    throw new Error(`Unsupported browser: ${String(params.browser)}`);
  }
  const binaryPath = getDownloaderBinaryPath('yt-dlp');
  if (!binaryPath) {
    throw new Error('YTDLP_NOT_INSTALLED');
  }
  // 0o700 私有临时目录（mkdtemp 默认）：yt-dlp 导出的是整个浏览器 cookie jar
  //（全站点会话），落文件由 yt-dlp 创建、权限位不受我们控制，用目录权限兜底
  const outDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-cookie-extract-'),
  );
  const outPath = path.join(outDir, 'cookies.txt');
  try {
    const browserProfile =
      params.browserProfile || listBrowserCookieProfiles(params.browser)[0]?.id;
    const browserSource = prepareBrowserCookieSource(
      params.browser,
      outDir,
      browserProfile,
    );
    const args = [
      '--ignore-config',
      '--cookies-from-browser',
      browserSource,
      '--cookies',
      outPath,
      '--skip-download',
      '--',
      DUMMY_URL,
    ];
    const result = await runProcess(binaryPath, args, {
      timeoutMs: BROWSER_EXTRACT_TIMEOUT_MS,
    });
    const rawOut = `${result.stderr}\n${result.stdout}`;
    // macOS TCC：Safari(容器) 与 Chromium 系读 cookie 库需「完全磁盘访问权限」，
    // 未授权时 yt-dlp 报 Operation not permitted / binarycookies。给可操作提示。
    if (isBrowserPermissionError(rawOut)) {
      throw new Error('BROWSER_PERMISSION_DENIED');
    }
    // 浏览器未安装 / 无用户数据：yt-dlp 报 could not find <browser> cookies database
    if (isBrowserNotFoundError(rawOut)) {
      throw new Error(`BROWSER_NOT_FOUND::${params.browser}`);
    }
    if (
      /failed to decrypt|cannot decrypt|could not (?:be decrypted|decrypt)|unable to decrypt|unknown cookie version|app.bound|DPAPI/i.test(
        rawOut,
      )
    ) {
      throw new Error('BROWSER_COOKIE_DECRYPT_FAILED');
    }
    if (!fs.existsSync(outPath)) {
      const detail = tailForError(result.stderr || result.stdout);
      throw new Error(
        `Browser cookie extraction produced no file${detail ? `: ${detail}` : ''}`,
      );
    }
    const text = fs.readFileSync(outPath, 'utf8');
    const cookies = parseNetscapeCookies(text);
    if (!cookies.length) throw new Error('NO_VALID_COOKIES');
    return { cookies, browserProfile };
  } catch (error) {
    if (
      ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code || '')
    ) {
      throw new Error('BROWSER_PERMISSION_DENIED');
    }
    throw error;
  } finally {
    safeRemove(outDir);
  }
}

/** macOS 完全磁盘访问权限缺失（TCC 拦截 Safari 容器 / Chromium cookie 库读取） */
function isBrowserPermissionError(output: string): boolean {
  return /operation not permitted|not permitted|permission denied|binarycookies/i.test(
    output,
  );
}

/** 浏览器未安装 / 无 cookie 数据库（yt-dlp: could not find <browser> cookies database） */
function isBrowserNotFoundError(output: string): boolean {
  return /could not find .*(cookies database|cookies? file)|no such file or directory/i.test(
    output,
  );
}

function safeRemove(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) {
    logMessage(`cookie extract temp cleanup failed: ${error}`, 'warning');
  }
}
