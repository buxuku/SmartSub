/**
 * 站点 Cookie 档案存储：元数据存 electron-store（settings.videoDownloadCookieProfiles），
 * cookie 内容单独落盘 userData/downloader-cookies/{id}.cookies（safeStorage 可用即加密）。
 * lux 对文件内 cookie 不做域名匹配，故导入时按档案 cookieDomains 过滤，内容按站点隔离。
 */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { store, logMessage } from '../storeManager';
import {
  COOKIE_SITE_PRESETS,
  getCookiePresetById,
  isValidCookieDomain,
  isValidCookieProfileId,
  matchCookieProfile,
} from '../../../types/download';
import type {
  CookieProfileMeta,
  CookieProfileSource,
  CookieProfileView,
} from '../../../types/download';
import {
  computeCookieStatus,
  filterCookiesByDomains,
  parseNetscapeCookies,
  serializeNetscapeCookies,
  type NetscapeCookie,
} from './cookies';

function getCookiesDir(): string {
  // 注意：不能用 'cookies'——macOS/Windows 大小写不敏感文件系统上会与 Electron 自身的
  // `userData/Cookies`（Chromium web cookie SQLite 库）撞路径，mkdir 报 EEXIST。
  return path.join(app.getPath('userData'), 'downloader-cookies');
}

function getContentPath(id: string): string {
  // 兜底执法：id 来自渲染进程/持久化元数据，拼路径前必须过白名单
  //（readMetas 过滤 + import/delete 前置校验后，此处正常不会触发）
  if (!isValidCookieProfileId(id)) {
    throw new Error(`Invalid cookie profile id: ${id}`);
  }
  return path.join(getCookiesDir(), `${id}.cookies`);
}

function readMetas(): CookieProfileMeta[] {
  try {
    const settings = store.get('settings') as {
      videoDownloadCookieProfiles?: CookieProfileMeta[];
    };
    const metas = settings?.videoDownloadCookieProfiles ?? [];
    // 元数据可经 setSettings 旁路写入，畸形 id 直接失效（下次 saveMetas 自愈清除）
    return metas.filter((m) => isValidCookieProfileId(m?.id));
  } catch {
    return [];
  }
}

function saveMetas(metas: CookieProfileMeta[]): void {
  const settings = (store.get('settings') || {}) as Record<string, unknown>;
  store.set('settings', { ...settings, videoDownloadCookieProfiles: metas });
}

/** 档案的匹配域/过滤域/关键 cookie（预设取常量，自定义取元数据） */
function resolveDomains(meta: CookieProfileMeta): {
  matchDomains: string[];
  cookieDomains: string[];
  keyCookieNames: string[];
} {
  if (meta.kind === 'preset') {
    const preset = getCookiePresetById(meta.id);
    return {
      matchDomains: preset?.matchDomains ?? [],
      cookieDomains: preset?.cookieDomains ?? [],
      keyCookieNames: preset?.keyCookieNames ?? [],
    };
  }
  return {
    matchDomains: meta.matchDomains ?? [],
    cookieDomains: meta.cookieDomains ?? [],
    keyCookieNames: [],
  };
}

interface ReadContentResult {
  cookies: NetscapeCookie[] | null;
  /** 解密/解析失败：内容损坏需重新导入 */
  needsReimport: boolean;
}

/** 读取并解密档案内容（不存在 → cookies:null；解密失败 → needsReimport） */
function readProfileCookies(meta: CookieProfileMeta): ReadContentResult {
  const contentPath = getContentPath(meta.id);
  if (!fs.existsSync(contentPath)) {
    return { cookies: null, needsReimport: false };
  }
  try {
    let text: string;
    if (meta.encrypted) {
      const buf = fs.readFileSync(contentPath);
      if (!safeStorage.isEncryptionAvailable()) {
        // 曾加密落盘但当前环境无法解密（钥匙串重置/跨机拷贝）
        return { cookies: null, needsReimport: true };
      }
      text = safeStorage.decryptString(buf);
    } else {
      text = fs.readFileSync(contentPath, 'utf8');
    }
    return { cookies: parseNetscapeCookies(text), needsReimport: false };
  } catch (error) {
    logMessage(`cookie profile ${meta.id} read failed: ${error}`, 'warning');
    return { cookies: null, needsReimport: true };
  }
}

/** 加密（可用时）落盘 cookie 内容，返回是否加密 */
function writeProfileCookies(id: string, cookies: NetscapeCookie[]): boolean {
  fs.mkdirSync(getCookiesDir(), { recursive: true });
  const text = serializeNetscapeCookies(cookies);
  const contentPath = getContentPath(id);
  // 0o600：明文回退（Linux 无 keyring）时凭据仅属主可读；加密件同权限保持一致
  const encrypted = safeStorage.isEncryptionAvailable();
  fs.writeFileSync(
    contentPath,
    encrypted ? safeStorage.encryptString(text) : text,
    { mode: 0o600 },
  );
  try {
    // writeFileSync 的 mode 仅在新建时生效，chmod 覆盖修复历史 0644 文件
    fs.chmodSync(contentPath, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，失败不阻断
  }
  return encrypted;
}

/** 组装单个档案视图（合并预设/自定义定义 + 内容计算状态） */
function toView(meta: CookieProfileMeta): CookieProfileView {
  const { matchDomains, cookieDomains, keyCookieNames } = resolveDomains(meta);
  const preset =
    meta.kind === 'preset' ? getCookiePresetById(meta.id) : undefined;
  const { cookies, needsReimport } = readProfileCookies(meta);
  const configured = cookies !== null && cookies.length > 0;
  const view: CookieProfileView = {
    id: meta.id,
    kind: meta.kind,
    name:
      meta.kind === 'preset'
        ? (preset?.nameKey ?? meta.id)
        : (meta.name ?? meta.id),
    isNameLiteral: meta.kind === 'custom',
    matchDomains,
    cookieDomains,
    hasRiskNote: preset?.hasRiskNote,
    configured,
    source: meta.source,
    importedAt: meta.importedAt,
    encrypted: meta.encrypted,
    needsReimport,
  };
  if (cookies && cookies.length) {
    const status = computeCookieStatus(cookies, keyCookieNames);
    view.cookieCount = status.cookieCount;
    view.expiresAt = status.expiresAt;
    view.expired = status.expired;
  }
  return view;
}

/**
 * 列出全部档案视图：预设档案恒常出现（未导入时 configured=false），
 * 自定义档案来自元数据。
 */
export function listCookieProfiles(): CookieProfileView[] {
  const metas = readMetas();
  const metaById = new Map(metas.map((m) => [m.id, m]));
  const views: CookieProfileView[] = [];

  for (const preset of COOKIE_SITE_PRESETS) {
    const meta = metaById.get(preset.id);
    if (meta) {
      views.push(toView(meta));
    } else {
      // 未导入的预设：占位视图（configured=false）
      views.push({
        id: preset.id,
        kind: 'preset',
        name: preset.nameKey,
        isNameLiteral: false,
        matchDomains: preset.matchDomains,
        cookieDomains: preset.cookieDomains,
        hasRiskNote: preset.hasRiskNote,
        configured: false,
      });
    }
  }
  for (const meta of metas) {
    if (meta.kind === 'custom') views.push(toView(meta));
  }
  return views;
}

/** 已配置档案的匹配列表（供 URL→档案 匹配，configured 恒为 true） */
function configuredMatchList(): Array<{
  id: string;
  matchDomains: string[];
  configured: true;
}> {
  return listCookieProfiles()
    .filter((v) => v.configured)
    .map((v) => ({ id: v.id, matchDomains: v.matchDomains, configured: true }));
}

/**
 * 按 URL 解析应注入的 cookie 明文（未命中/损坏 → null）。
 * 注入侧（withCookieFile）据此写临时副本；返回明文以便加密档案也能落临时文件。
 */
export function resolveCookieTextForUrl(url: string): string | null {
  const matchedId = matchCookieProfile(url, configuredMatchList());
  if (!matchedId) return null;
  const meta = readMetas().find((m) => m.id === matchedId);
  if (!meta) return null;
  const { cookies } = readProfileCookies(meta);
  if (!cookies || !cookies.length) return null;
  return serializeNetscapeCookies(cookies);
}

export interface ImportResult {
  profile: CookieProfileView;
  /** 过滤后落盘的 cookie 条数 */
  cookieCount: number;
}

/**
 * 自定义档案域定义归一 + 校验：小写去空白；拒绝空表与非法域
 * （裸 TLD 会在后缀匹配下命中全网站点，见 isValidCookieDomain）。
 */
function normalizeCustomDef(customDef: {
  name: string;
  matchDomains: string[];
  cookieDomains: string[];
}): { name: string; matchDomains: string[]; cookieDomains: string[] } {
  const normalize = (domains: string[], field: string): string[] => {
    if (!Array.isArray(domains) || domains.length === 0) {
      throw new Error(`Custom profile ${field} is required`);
    }
    return domains.map((domain) => {
      if (!isValidCookieDomain(domain)) {
        throw new Error(`Invalid ${field} domain: ${String(domain)}`);
      }
      return domain.trim().toLowerCase();
    });
  };
  return {
    name: typeof customDef.name === 'string' ? customDef.name : '',
    matchDomains: normalize(customDef.matchDomains, 'matchDomains'),
    cookieDomains: normalize(customDef.cookieDomains, 'cookieDomains'),
  };
}

/**
 * 导入 cookie 到指定档案：解析 → 按 cookieDomains 过滤 → 落盘 + 更新元数据。
 * customDef 用于自定义档案首次创建（name/域定义）。过滤后为空视为导入失败。
 */
export function importCookiesToProfile(params: {
  id: string;
  cookies: NetscapeCookie[];
  source: CookieProfileSource;
  customDef?: { name: string; matchDomains: string[]; cookieDomains: string[] };
}): ImportResult {
  const { id, cookies, source } = params;
  if (!isValidCookieProfileId(id)) {
    throw new Error(`Invalid cookie profile id: ${id}`);
  }
  const customDef = params.customDef
    ? normalizeCustomDef(params.customDef)
    : undefined;
  const metas = readMetas();
  const existing = metas.find((m) => m.id === id);
  const isPreset = Boolean(getCookiePresetById(id));

  let cookieDomains: string[];
  if (isPreset) {
    cookieDomains = getCookiePresetById(id)!.cookieDomains;
  } else if (existing?.cookieDomains) {
    cookieDomains = existing.cookieDomains;
  } else if (customDef) {
    cookieDomains = customDef.cookieDomains;
  } else {
    throw new Error('custom profile definition required');
  }

  const filtered = filterCookiesByDomains(cookies, cookieDomains);
  if (filtered.length === 0) {
    throw new Error(
      `No cookies matched profile domains (${cookieDomains.join(', ')})`,
    );
  }

  const encrypted = writeProfileCookies(id, filtered);
  const meta: CookieProfileMeta = {
    id,
    kind: isPreset ? 'preset' : 'custom',
    importedAt: Date.now(),
    source,
    encrypted,
    ...(isPreset
      ? {}
      : {
          name: customDef?.name ?? existing?.name ?? id,
          matchDomains: customDef?.matchDomains ?? existing?.matchDomains,
          cookieDomains: customDef?.cookieDomains ?? existing?.cookieDomains,
        }),
  };
  const nextMetas = existing
    ? metas.map((m) => (m.id === id ? meta : m))
    : [...metas, meta];
  saveMetas(nextMetas);

  return { profile: toView(meta), cookieCount: filtered.length };
}

/** 档案的 cookie 过滤域（预设取常量 / customDef 优先 / 回退已存元数据） */
export function getProfileCookieDomains(
  id: string,
  customDef?: { cookieDomains: string[] },
): string[] {
  const preset = getCookiePresetById(id);
  if (preset) return preset.cookieDomains;
  if (customDef) return customDef.cookieDomains;
  return readMetas().find((m) => m.id === id)?.cookieDomains ?? [];
}

/** 删除档案：清内容文件与元数据 */
export function deleteCookieProfile(id: string): boolean {
  if (!isValidCookieProfileId(id)) return false;
  const contentPath = getContentPath(id);
  try {
    if (fs.existsSync(contentPath)) fs.rmSync(contentPath, { force: true });
  } catch (error) {
    logMessage(`cookie profile ${id} file remove failed: ${error}`, 'warning');
  }
  const metas = readMetas();
  const next = metas.filter((m) => m.id !== id);
  saveMetas(next);
  return next.length !== metas.length;
}
