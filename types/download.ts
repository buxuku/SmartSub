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
