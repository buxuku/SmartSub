import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  COOKIE_BROWSERS,
  type BrowserCookieProfile,
} from '../../../types/download';

function chromiumDataDir(browser: string): string | undefined {
  const home = os.homedir();
  const locations: Record<string, string> =
    process.platform === 'darwin'
      ? {
          chrome: 'Google/Chrome',
          edge: 'Microsoft Edge',
          brave: 'BraveSoftware/Brave-Browser',
        }
      : process.platform === 'win32'
        ? {
            chrome: 'Google/Chrome/User Data',
            edge: 'Microsoft/Edge/User Data',
            brave: 'BraveSoftware/Brave-Browser/User Data',
          }
        : {
            chrome: 'google-chrome',
            edge: 'microsoft-edge',
            brave: 'BraveSoftware/Brave-Browser',
          };
  const relative = locations[browser];
  if (!relative) return undefined;
  const base =
    process.platform === 'darwin'
      ? path.join(home, 'Library/Application Support')
      : process.platform === 'win32'
        ? process.env.LOCALAPPDATA || path.join(home, 'AppData/Local')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, relative);
}

/**
 * yt-dlp 会递归选取最新的 Cookies 文件，可能误选 Chrome 的 Storage/ext 内部库。
 * 仅从顶层用户档案选主库，复制到调用方的私有临时目录供提取，避免递归进入内部库。
 * Local State 放在档案的上一级，保留 Chromium 解密器需要的元数据。
 */
function findChromiumProfiles(browser: string) {
  if (!(COOKIE_BROWSERS as readonly string[]).includes(browser)) {
    throw new Error(`Unsupported browser: ${String(browser)}`);
  }
  const root = chromiumDataDir(browser);
  if (!root || !fs.existsSync(root)) return undefined;

  let lastUsed: string | undefined;
  let infoCache: Record<string, { name?: string }> = {};
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(root, 'Local State'), 'utf8'),
    );
    const name = state.profile?.last_used;
    infoCache = state.profile?.info_cache ?? {};
    if (
      typeof name === 'string' &&
      name &&
      name !== '.' &&
      name !== '..' &&
      !/[\\/]/.test(name)
    ) {
      lastUsed = name;
    }
  } catch {
    // 缺少 Local State 时仍可按真实档案主库的更新时间选择。
  }
  const names = fs
    .readdirSync(root)
    .filter((name) => name === 'Default' || /^Profile \d+$/.test(name));
  if (lastUsed && !names.includes(lastUsed)) names.push(lastUsed);
  const databases = names.flatMap((name) =>
    ['Network/Cookies', 'Cookies'].flatMap((relative) => {
      const file = path.join(root, name, relative);
      if (!fs.existsSync(file)) return [];
      const stat = fs.statSync(file);
      return stat.isFile() ? [{ name, file, modified: stat.mtimeMs }] : [];
    }),
  );
  databases.sort(
    (a, b) =>
      Number(b.name === lastUsed) - Number(a.name === lastUsed) ||
      b.modified - a.modified,
  );
  return { root, databases, infoCache };
}

/** 仅返回真实用户档案；不给 renderer 暴露文件路径或凭据。 */
export function listBrowserCookieProfiles(
  browser: string,
): BrowserCookieProfile[] {
  const found = findChromiumProfiles(browser);
  if (!found) return [];
  const names = [...new Set(found.databases.map((db) => db.name))];
  return names.map((id, index) => ({
    id,
    name:
      typeof found.infoCache[id]?.name === 'string'
        ? found.infoCache[id].name!
        : id,
    isDefault: index === 0,
  }));
}

export function prepareBrowserCookieSource(
  browser: string,
  outDir: string,
  profile?: string,
): string {
  const found = findChromiumProfiles(browser);
  if (!found) {
    if (profile) throw new Error('BROWSER_PROFILE_NOT_FOUND');
    return browser;
  }
  const { root, databases } = found;
  if (!databases.length) throw new Error(`BROWSER_NOT_FOUND::${browser}`);
  // 只接受枚举得到的档案 ID，不接受路径和 yt-dlp 的其它参数语法。
  const selected = profile
    ? databases.find((db) => db.name === profile)
    : databases[0];
  if (!selected) throw new Error('BROWSER_PROFILE_NOT_FOUND');

  const profileDir = path.join(outDir, 'browser-profile');
  fs.mkdirSync(profileDir, { mode: 0o700 });
  fs.copyFileSync(selected.file, path.join(profileDir, 'Cookies'));
  const localState = path.join(root, 'Local State');
  if (fs.existsSync(localState)) {
    fs.copyFileSync(localState, path.join(outDir, 'Local State'));
  }
  return `${browser}:${profileDir}`;
}
