/**
 * 在线视频下载：引擎、任务条目与下载器分发清单的共享类型
 * （main 与 renderer 皆从此引入；纯类型 + 少量纯函数，禁止 Node/Electron 依赖）。
 */

/** 下载引擎标识 */
export type DownloaderEngine = 'yt-dlp' | 'lux';

export const DOWNLOADER_ENGINES: DownloaderEngine[] = ['yt-dlp', 'lux'];

/** 引擎选择：auto = 按域名路由 */
export type DownloadEngineChoice = 'auto' | DownloaderEngine;

/** 清晰度档位（首版固定档位，预检不满足时由引擎就近降档） */
export type DownloadQuality = 'best' | '1080p' | '720p';

/** 与流水线阶段一致的字符串状态机约定 */
export type DownloadEntryStatus = '' | 'loading' | 'done' | 'error';

/** 预检/下载过程中获得的媒体元数据 */
export interface DownloadEntryMeta {
  title?: string;
  /** 秒 */
  duration?: number;
  thumbnail?: string;
  /** 播放列表条目数（>0 时该 URL 是列表；由预检确认展开范围） */
  playlistCount?: number;
  /** 播放列表条目（预检 --flat-playlist 提供；展开确认后逐条建 DownloadEntry） */
  playlistItems?: Array<{ url: string; title?: string }>;
  /** 可用清晰度（高度像素，降序），预检时填充 */
  heights?: number[];
  /** 远端声明的总字节数（lux 进度降级估算用） */
  totalBytes?: number;
  /** 官方字幕语言列表（yt-dlp 预检 `subtitles` 字段；自动字幕不计入） */
  subtitleLangs?: string[];
}

/** 一条下载链接在任务里的状态载体（一个 download WorkItem 含 N 条） */
export interface DownloadEntry {
  id: string;
  url: string;
  /** 实际执行引擎（含失败回退后的结果；未执行时为路由预期值） */
  engine: DownloaderEngine;
  status: DownloadEntryStatus;
  /** 0-100 */
  progress?: number;
  /** 人类可读速度（如 "3.2MiB/s"） */
  speed?: string;
  /** 人类可读剩余时间（如 "00:41"） */
  eta?: string;
  meta?: DownloadEntryMeta;
  /** 完成后的媒体文件绝对路径 */
  outputPath?: string;
  /** 同取的官方字幕文件绝对路径（与视频同目录同主干） */
  subtitlePaths?: string[];
  error?: string;
  /** 该 URL 是播放列表且用户确认展开全部（引擎侧传 --yes-playlist 语义） */
  expandPlaylist?: boolean;
}

/** 预检（不下载）单条结果 */
export interface DownloadPreflightResult {
  url: string;
  ok: boolean;
  engine: DownloaderEngine;
  meta?: DownloadEntryMeta;
  error?: string;
}

/** download WorkItem 的 configSnapshot 形状 */
export interface DownloadConfigSnapshot {
  savePath: string;
  quality: DownloadQuality;
  engine: DownloadEngineChoice;
  /** 同时下载官方字幕（默认开；仅 yt-dlp 引擎生效） */
  writeSubs?: boolean;
  /** 预留：链式自动化（本期不实现） */
  autoChain?: Record<string, unknown>;
}

// ── 下载器二进制分发 ────────────────────────────────────────────────────────

/** 平台键：`${process.platform}-${process.arch}`（如 darwin-arm64 / win32-x64） */
export type DownloaderPlatformKey = string;

export interface DownloaderAssetInfo {
  /** release 内的资产文件名（下载后即最终二进制，单文件无归档） */
  name: string;
  sha256: string;
  /** 字节数（断点续传与完整性预校验用） */
  size?: number;
}

export interface DownloaderEngineManifest {
  /** 日期化版本（yt-dlp: 2026.07.04；lux: 构建日期 2026.07.21） */
  version: string;
  updateNotes?: string;
  assets: Record<DownloaderPlatformKey, DownloaderAssetInfo>;
}

/** downloader-versions.json 顶层结构（模式对齐 addon-versions.json） */
export interface DownloaderVersionsManifest {
  generatedAt?: string;
  engines: Partial<Record<DownloaderEngine, DownloaderEngineManifest>>;
}

export interface InstalledDownloaderInfo {
  engine: DownloaderEngine;
  version: string;
  binaryPath: string;
}

/** 单引擎的安装/更新状态（渲染层引导卡消费） */
export interface DownloaderStatus {
  engine: DownloaderEngine;
  installed: InstalledDownloaderInfo | null;
  latestVersion: string | null;
  hasUpdate: boolean;
}

export type DownloaderInstallPhase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'completed'
  | 'error';

export interface DownloaderInstallProgress {
  engine: DownloaderEngine;
  phase: DownloaderInstallPhase;
  /** 0-100 */
  progress: number;
  error?: string;
}

// ── 纯函数（main / renderer 共用） ─────────────────────────────────────────

/** URL 末尾常见的中英文标点（粘贴聊天记录时容易黏连） */
const TRAILING_PUNCTUATION = /[)\]}>,.;:!?'"、，。；：！？）】》'"]+$/;

/**
 * 从混杂文本中抽取 http(s) 链接并按出现顺序去重。
 * 支持一行多链接与前后缀噪音（如「链接：https://... 快看」）。
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(TRAILING_PUNCTUATION, '');
    if (!cleaned || seen.has(cleaned)) continue;
    try {
      // 非法 URL（如裸 "http://"）丢弃
      new URL(cleaned);
    } catch {
      continue;
    }
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}

/**
 * lux 优先的域名（含子域匹配）；未命中一律 yt-dlp。
 * 注意 B 站不在列：实测匿名态 lux 只能取到 360P/480P，而 yt-dlp 能取到 1080P，
 * B 站走 yt-dlp 优先（失败仍会回退 lux）。lux 保留给 yt-dlp 适配不稳的国内站点。
 * （配置 bilibili Cookie 档案后 lux 亦可取登录态高清，但 yt-dlp 优先不变——
 * 匿名基线 yt-dlp 仍更优，cookie 只是叠加登录态收益，见 add-downloader-cookie-import）
 */
export const LUX_PREFERRED_DOMAINS = [
  'douyin.com',
  'ixigua.com',
  'xiaohongshu.com',
  'xhslink.com',
  'kuaishou.com',
  'weibo.com',
  'zhihu.com',
];

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * 域名路由：返回引擎偏好序（首选在前，回退在后）。
 * - override 指定引擎：仅该引擎（用户手动指定跳过回退换引擎）。
 * - auto：按域名表决定首选，另一引擎作回退。
 * - installed 过滤未安装引擎；两个都装了才有回退项（单引擎降级）。
 */
export function routeEngines(
  url: string,
  override: DownloadEngineChoice,
  installed: DownloaderEngine[],
): DownloaderEngine[] {
  if (override !== 'auto') {
    return installed.includes(override) ? [override] : [];
  }
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const luxFirst = LUX_PREFERRED_DOMAINS.some((d) => hostMatches(host, d));
  const order: DownloaderEngine[] = luxFirst
    ? ['lux', 'yt-dlp']
    : ['yt-dlp', 'lux'];
  return order.filter((engine) => installed.includes(engine));
}

// ── 站点 Cookie 档案（登录态注入） ──────────────────────────────────────────

/** cookie 档案导入来源 */
export type CookieProfileSource = 'browser' | 'file' | 'paste';

/**
 * 预设站点档案定义（代码常量，非持久化）。
 * matchDomains：条目 URL → 档案匹配域（含短链别名，如 b23.tv/youtu.be）。
 * cookieDomains：导入过滤白名单（cookie 行 domain 字段后缀匹配，丢弃无关站点）。
 * keyCookieNames：过期判定基准 cookie 名（登录态失效的关键凭据）。
 */
export interface CookieProfilePreset {
  id: string;
  /** i18n 展示名键（renderer 用 t() 解析） */
  nameKey: string;
  matchDomains: string[];
  cookieDomains: string[];
  keyCookieNames: string[];
  /** 附账号风控提示（youtube 带 cookie 批量下载有风险） */
  hasRiskNote?: boolean;
}

/**
 * 预设站点档案表。lux 对文件内 cookie 不做域名匹配（全量附到每个请求），
 * 因此每档案的 cookieDomains 决定导入过滤边界，避免跨站会话泄漏。
 */
export const COOKIE_SITE_PRESETS: CookieProfilePreset[] = [
  {
    id: 'bilibili',
    nameKey: 'cookie.presetBilibili',
    matchDomains: ['bilibili.com', 'b23.tv'],
    cookieDomains: ['bilibili.com'],
    keyCookieNames: ['SESSDATA'],
  },
  {
    id: 'youtube',
    nameKey: 'cookie.presetYoutube',
    matchDomains: ['youtube.com', 'youtu.be'],
    cookieDomains: ['youtube.com', 'google.com'],
    keyCookieNames: ['LOGIN_INFO'],
    hasRiskNote: true,
  },
];

export function getCookiePresetById(
  id: string,
): CookieProfilePreset | undefined {
  return COOKIE_SITE_PRESETS.find((p) => p.id === id);
}

/**
 * 持久化的档案元数据（内容单独落盘 userData/cookies/{id}.cookies）。
 * 预设档案仅在已导入时才有元数据记录；自定义档案额外带 name/域定义。
 */
export interface CookieProfileMeta {
  id: string;
  kind: 'preset' | 'custom';
  importedAt: number;
  source: CookieProfileSource;
  /** safeStorage 加密落盘（false=明文回退，如 Linux 无 keyring） */
  encrypted: boolean;
  /** 自定义档案的展示名与域定义（预设从 COOKIE_SITE_PRESETS 取） */
  name?: string;
  matchDomains?: string[];
  cookieDomains?: string[];
}

/** cookie 档案 + 计算状态（渲染层与匹配消费） */
export interface CookieProfileView {
  id: string;
  kind: 'preset' | 'custom';
  /** 预设为 i18n 键，自定义为用户输入的原文名 */
  name: string;
  /** 自定义档案 name 为原文（非 i18n 键） */
  isNameLiteral: boolean;
  matchDomains: string[];
  cookieDomains: string[];
  hasRiskNote?: boolean;
  /** 是否已导入内容 */
  configured: boolean;
  source?: CookieProfileSource;
  importedAt?: number;
  encrypted?: boolean;
  /** cookie 条数 */
  cookieCount?: number;
  /** 关键/最早 cookie 过期（秒 epoch，0/缺省=会话 cookie 无过期信息） */
  expiresAt?: number;
  /** 已过期 */
  expired?: boolean;
  /** 解密失败/内容损坏，需重新导入 */
  needsReimport?: boolean;
}

/**
 * URL 匹配站点档案：返回命中档案 id（后缀域匹配，含短链别名），未命中 null。
 * 仅匹配已配置（configured）档案，避免给未导入档案传空 cookie 文件。
 */
export function matchCookieProfile(
  url: string,
  profiles: Array<{ id: string; matchDomains: string[]; configured?: boolean }>,
): string | null {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const profile of profiles) {
    if (profile.configured === false) continue;
    if (profile.matchDomains.some((d) => hostMatches(host, d))) {
      return profile.id;
    }
  }
  return null;
}
