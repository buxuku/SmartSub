/**
 * 站点 Cookie 档案存储：元数据存 electron-store（settings.videoDownloadCookieProfiles），
 * cookie 内容单独落盘 userData/downloader-cookies/{id}.{generation}.cookies（safeStorage 可用即加密）。
 * lux 对文件内 cookie 不做域名匹配，故导入时按档案 cookieDomains 过滤，内容按站点隔离。
 */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
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
  CookieBatchImportResult,
  CookieImportOrigin,
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

function getContentPath(id: string, contentFile?: string): string {
  // 兜底执法：id 来自渲染进程/持久化元数据，拼路径前必须过白名单
  //（readMetas 过滤 + import/delete 前置校验后，此处正常不会触发）
  if (!isValidCookieProfileId(id)) {
    throw new Error(`Invalid cookie profile id: ${id}`);
  }
  if (
    contentFile &&
    !new RegExp(`^${id}\\.[0-9a-f-]{36}\\.cookies$`, 'i').test(contentFile)
  ) {
    throw new Error('Invalid cookie content file');
  }
  return path.join(getCookiesDir(), contentFile || `${id}.cookies`);
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

/** 已知平台只保留公开视频主机及可适用的父域 Cookie，不收集后台兄弟主机。 */
function filterProfileCookies(
  cookies: NetscapeCookie[],
  definition: Pick<
    CookieProfileMeta,
    'id' | 'kind' | 'matchDomains' | 'cookieDomains'
  >,
): NetscapeCookie[] {
  const preset =
    getCookiePresetById(definition.id) ||
    getCookiePresetById(coveredPreset(definition) || '');
  if (!preset)
    return filterCookiesByDomains(cookies, definition.cookieDomains ?? []);
  const hosts =
    preset.cookieHosts ??
    preset.cookieDomains.flatMap((domain) => [
      domain,
      `www.${domain}`,
      `m.${domain}`,
    ]);
  return filterCookiesByDomains(cookies, hosts, false);
}

/** 读取并解密档案内容（不存在 → cookies:null；解密失败 → needsReimport） */
function readProfileCookies(meta: CookieProfileMeta): ReadContentResult {
  try {
    const contentPath = getContentPath(meta.id, meta.contentFile);
    if (!fs.existsSync(contentPath))
      return { cookies: null, needsReimport: true };
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
    const cookies = filterProfileCookies(parseNetscapeCookies(text), meta);
    return { cookies, needsReimport: cookies.length === 0 };
  } catch (error) {
    logMessage(`cookie profile ${meta.id} read failed: ${error}`, 'warning');
    return { cookies: null, needsReimport: true };
  }
}

function removeContent(meta: CookieProfileMeta): void {
  try {
    fs.rmSync(getContentPath(meta.id, meta.contentFile), { force: true });
  } catch {
    logMessage(`cookie profile ${meta.id} cleanup failed`, 'warning');
  }
}

/** 将旧版手动添加的已知站点收敛到预设，避免旧的窄域档案遮住新登录态。 */
function coveredPreset(
  meta: Pick<CookieProfileMeta, 'kind' | 'matchDomains' | 'cookieDomains'>,
): string | undefined {
  if (meta.kind !== 'custom') return undefined;
  const covered = (domains: string[] | undefined, allowed: string[]) =>
    Boolean(domains?.length) &&
    domains!.every((domain) =>
      allowed.some(
        (parent) => domain === parent || domain.endsWith(`.${parent}`),
      ),
    );
  return COOKIE_SITE_PRESETS.find(
    (preset) =>
      covered(meta.matchDomains, preset.matchDomains) &&
      covered(meta.cookieDomains, preset.cookieDomains),
  )?.id;
}

/** 先写不可变内容，全部成功后一次发布元数据；任何失败都保留原档案。 */
function commitProfiles(
  entries: Array<{ meta: CookieProfileMeta; cookies: NetscapeCookie[] }>,
  previous: CookieProfileMeta[],
): CookieProfileView[] {
  fs.mkdirSync(getCookiesDir(), { recursive: true, mode: 0o700 });
  const staged: CookieProfileMeta[] = [];
  const updatedIds = new Set(entries.map(({ meta }) => meta.id));
  const replacedIds = new Set([
    ...updatedIds,
    ...previous
      .filter((meta) => updatedIds.has(coveredPreset(meta) || ''))
      .map((meta) => meta.id),
  ]);
  try {
    for (const { meta, cookies } of entries) {
      meta.encrypted = safeStorage.isEncryptionAvailable();
      meta.contentFile = `${meta.id}.${randomUUID()}.cookies`;
      staged.push(meta);
      const text = serializeNetscapeCookies(cookies);
      fs.writeFileSync(
        getContentPath(meta.id, meta.contentFile),
        meta.encrypted ? safeStorage.encryptString(text) : text,
        { mode: 0o600, flag: 'wx' },
      );
    }
    saveMetas([
      ...previous.filter((meta) => !replacedIds.has(meta.id)),
      ...staged,
    ]);
  } catch (error) {
    staged.forEach(removeContent);
    throw error;
  }
  previous.filter((meta) => replacedIds.has(meta.id)).forEach(removeContent);
  return staged.map(toView);
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
    browser: meta.browser,
    browserProfile: meta.browserProfile,
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

/**
 * 按 URL 解析应注入的 cookie 明文（未命中/损坏 → null）。
 * 注入侧（withCookieFile）据此写临时副本；返回明文以便加密档案也能落临时文件。
 */
export function resolveCookieTextForUrl(url: string): string | null {
  // 只解密匹配的档案；不为每条下载链接读取所有站点凭据。
  const candidates = readMetas().map((meta) => ({
    ...meta,
    ...resolveDomains(meta),
  }));
  while (candidates.length) {
    const matchedId = matchCookieProfile(url, candidates);
    if (!matchedId) return null;
    const index = candidates.findIndex((meta) => meta.id === matchedId);
    const [meta] = candidates.splice(index, 1);
    const { cookies } = readProfileCookies(meta);
    if (cookies?.length) return serializeNetscapeCookies(cookies);
  }
  return null;
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
export function importCookiesToProfile(
  params: {
    id: string;
    cookies: NetscapeCookie[];
    source: CookieProfileSource;
    customDef?: {
      name: string;
      matchDomains: string[];
      cookieDomains: string[];
    };
  } & CookieImportOrigin,
): ImportResult {
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

  const filtered = filterProfileCookies(cookies, {
    id,
    kind: isPreset ? 'preset' : 'custom',
    cookieDomains,
    matchDomains: customDef?.matchDomains ?? existing?.matchDomains,
  });
  if (filtered.length === 0) {
    throw new Error(
      `No cookies matched profile domains (${cookieDomains.join(', ')})`,
    );
  }

  const meta: CookieProfileMeta = {
    id,
    kind: isPreset ? 'preset' : 'custom',
    importedAt: Date.now(),
    source,
    encrypted: false,
    browser: params.browser,
    browserProfile: params.browserProfile,
    ...(isPreset
      ? {}
      : {
          name: customDef?.name ?? existing?.name ?? id,
          matchDomains: customDef?.matchDomains ?? existing?.matchDomains,
          cookieDomains: customDef?.cookieDomains ?? existing?.cookieDomains,
        }),
  };
  const [profile] = commitProfiles([{ meta, cookies: filtered }], metas);
  return { profile, cookieCount: filtered.length };
}

/** 全量读入，但仅持久化目录内站点和用户已经定义的站点。未知站点不落盘。 */
export function importCookiesForSites(
  params: {
    cookies: NetscapeCookie[];
    source: CookieProfileSource;
  } & CookieImportOrigin,
): CookieBatchImportResult {
  const metas = readMetas();
  const definitions = [
    ...COOKIE_SITE_PRESETS.map((preset) => ({
      id: preset.id,
      kind: 'preset' as const,
      cookieDomains: preset.cookieDomains,
    })),
    ...metas.filter((meta) => meta.kind === 'custom'),
  ];
  const refreshedPresets = new Set(
    COOKIE_SITE_PRESETS.filter(
      (preset) =>
        filterProfileCookies(params.cookies, { ...preset, kind: 'preset' })
          .length > 0,
    ).map((preset) => preset.id),
  );
  const matchedCookies = new Set<NetscapeCookie>();
  const entries = definitions.flatMap((definition) => {
    if (
      definition.kind === 'custom' &&
      refreshedPresets.has(coveredPreset(definition as CookieProfileMeta) || '')
    )
      return [];
    const cookies = filterProfileCookies(params.cookies, definition);
    if (!cookies.length) return [];
    cookies.forEach((cookie) => matchedCookies.add(cookie));
    const meta: CookieProfileMeta = {
      ...definition,
      importedAt: Date.now(),
      source: params.source,
      encrypted: false,
      browser: params.browser,
      browserProfile: params.browserProfile,
    };
    return [{ meta, cookies }];
  });
  if (!entries.length) throw new Error('NO_SUPPORTED_SITE_COOKIES');
  return {
    profiles: commitProfiles(entries, metas),
    cookieCount: matchedCookies.size,
    ignoredCookieCount: params.cookies.length - matchedCookies.size,
  };
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
  const metas = readMetas();
  const next = metas.filter((m) => m.id !== id);
  saveMetas(next);
  metas.filter((meta) => meta.id === id).forEach(removeContent);
  return next.length !== metas.length;
}

/** 清空本应用的 Cookie（包括未被元数据引用的旧文件），不触碰浏览器源数据库。 */
export function clearCookieProfiles(): void {
  fs.rmSync(getCookiesDir(), { recursive: true, force: true });
  saveMetas([]);
}
