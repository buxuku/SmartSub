/**
 * 视频合成预览「黑屏」诊断：渲染进程这一侧的实验开关、事件日志、主进程信息缓存。
 *
 * 设计约束：
 *  - 所有开关的默认值 = 3.9.0 的行为。正式版里没有人会改它们，诊断面板也不会出现，
 *    所以这里的代码在正式版是惰性的（diagLog 直接返回，开关永远是默认值）。
 *  - 一次只改一个变量：每个开关都对应一个具体假设（见各字段注释），面板里逐个勾选对照。
 *  - 开关只存在于内存里，不持久化：每次启动都是 3.9.0 的默认行为，不会因为上次忘了关而困惑。
 */
import { useEffect, useSyncExternalStore } from 'react';

export type DesyncMode = 'unchanged' | 'false';
export type PowerMode = 'unchanged' | 'default' | 'low-power';
export type RendererMode = 'auto' | 'webgl2' | 'webgl1' | '2d';
export type HandleMode = 'hover' | 'pinned' | 'hidden';

export interface PreviewDiagFlags {
  /** 完全不创建 JASSUB（回退到 CSS 模拟字幕）。黑屏消失 ⇒ 与 JASSUB 有关。 */
  disableJassub: boolean;
  /** JASSUB 画布保留但永不显示（display:none）。区分「画布本身」和「JASSUB 引擎在跑」。 */
  jassubHideCanvas: boolean;
  /** 3.9.0 新增的字幕范围测量：每 100ms 从 JASSUB 画布 drawImage + getImageData 回读。关掉 ⇒ 排除回读。 */
  boundsReadback: boolean;
  /** WebGL 上下文的 desynchronized（JASSUB 默认 true）。上游 JASSUB#70：Windows 上它会导致黑屏。 */
  jassubDesync: DesyncMode;
  /** WebGL 上下文的 powerPreference（JASSUB 默认 high-performance）。双显卡笔记本上会选独显。 */
  jassubPower: PowerMode;
  /** 强制 JASSUB 的渲染后端，绕开 WebGL2。 */
  jassubRenderer: RendererMode;
  /** 整个字幕拖拽层（SubtitleCanvas，z-10，含 hover 才出现的手柄）是否挂载。 */
  subtitleLayer: boolean;
  /** 手柄显示方式：hover=3.9.0（鼠标进入视频才显示）；pinned=常显；hidden=不渲染。 */
  handleMode: HandleMode;
  /** 视频容器加 filter: opacity(0.999)。非根渲染通道不参与 DirectComposition 叠加层（JASSUB#70 的绕法）。 */
  ancestorFilter: boolean;
  /** 恢复 3.8 的圆角裁剪（rounded-lg）。圆角会让视频走 underlay 路径，3.9.0 去掉了它。 */
  roundedClip: boolean;
  /** 关闭全局 *:hover 的滚动条配色规则。左侧面板里鼠标一进来就会触发它。 */
  noHoverScrollbar: boolean;
  /** 在视频区域右上角显示一个每 100ms 刷新的时钟。黑屏时它还在不在，说明黑的是不是整块 DOM。 */
  marker: boolean;
}

export const DEFAULT_FLAGS: Readonly<PreviewDiagFlags> = Object.freeze({
  disableJassub: false,
  jassubHideCanvas: false,
  boundsReadback: true,
  jassubDesync: 'unchanged',
  jassubPower: 'unchanged',
  jassubRenderer: 'auto',
  subtitleLayer: true,
  handleMode: 'hover',
  ancestorFilter: false,
  roundedClip: false,
  noHoverScrollbar: false,
  marker: false,
});

/** 「全部缓解」：把所有怀疑项一次性关掉。若黑屏消失，再逐项还原找出真凶（二分）。 */
export const MITIGATE_ALL_FLAGS: Readonly<Partial<PreviewDiagFlags>> =
  Object.freeze({
    boundsReadback: false,
    subtitleLayer: false,
    jassubDesync: 'false',
    ancestorFilter: true,
    roundedClip: true,
    noHoverScrollbar: true,
  });

const ENUMS: Record<string, readonly string[]> = {
  jassubDesync: ['unchanged', 'false'],
  jassubPower: ['unchanged', 'default', 'low-power'],
  jassubRenderer: ['auto', 'webgl2', 'webgl1', '2d'],
  handleMode: ['hover', 'pinned', 'hidden'],
};

/** 把任意输入规整成合法的开关集合：未知键丢弃，类型不对的字段回退到默认值。 */
export function normalizeFlags(input: unknown): PreviewDiagFlags {
  const source = (input ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = { ...DEFAULT_FLAGS };
  for (const key of Object.keys(DEFAULT_FLAGS)) {
    const fallback = (DEFAULT_FLAGS as unknown as Record<string, unknown>)[key];
    const value = source[key];
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') result[key] = value;
    } else if (typeof value === 'string' && ENUMS[key]?.includes(value)) {
      result[key] = value;
    }
  }
  return result as unknown as PreviewDiagFlags;
}

/** 与默认值不同的开关，用于日志与「已开启 N 项」。 */
export function changedFlags(
  flags: PreviewDiagFlags,
): Partial<PreviewDiagFlags> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_FLAGS) as Array<
    keyof PreviewDiagFlags
  >) {
    if (flags[key] !== DEFAULT_FLAGS[key]) changed[key] = flags[key];
  }
  return changed as Partial<PreviewDiagFlags>;
}

export interface JassubDiagOption {
  desynchronized?: boolean;
  powerPreference?: 'default' | 'low-power';
  renderer?: 'webgl2' | 'webgl1' | '2d';
}

/**
 * 传给 JASSUB 构造函数的 diag 选项。全是默认值时返回 undefined：
 * 即使诊断补丁已经打进 JASSUB，也走与原版完全相同的路径。
 */
export function jassubDiagOption(
  flags: PreviewDiagFlags,
): JassubDiagOption | undefined {
  const option: JassubDiagOption = {};
  if (flags.jassubDesync === 'false') option.desynchronized = false;
  if (flags.jassubPower !== 'unchanged')
    option.powerPreference = flags.jassubPower;
  if (flags.jassubRenderer !== 'auto') option.renderer = flags.jassubRenderer;
  return Object.keys(option).length > 0 ? option : undefined;
}

/** diag 选项的稳定字符串：改动它就必须重建 JASSUB（上下文属性只在创建时生效）。 */
export function jassubDiagKey(flags: PreviewDiagFlags): string {
  const option = jassubDiagOption(flags);
  return option ? JSON.stringify(option) : '';
}

// ───────────────────────── 开关 store ─────────────────────────

let flags: PreviewDiagFlags = DEFAULT_FLAGS;
const flagListeners = new Set<() => void>();

export function getPreviewDiagFlags(): PreviewDiagFlags {
  return flags;
}

function subscribeFlags(listener: () => void): () => void {
  flagListeners.add(listener);
  return () => flagListeners.delete(listener);
}

function applyDocumentFlags(next: PreviewDiagFlags): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(
    'diag-no-hover-scrollbar',
    next.noHoverScrollbar,
  );
}

export function setPreviewDiagFlags(
  patch: Partial<PreviewDiagFlags>,
  reason = 'user',
): void {
  const next = normalizeFlags({ ...flags, ...patch });
  if (JSON.stringify(next) === JSON.stringify(flags)) return;
  flags = next;
  applyDocumentFlags(next);
  flagListeners.forEach((listener) => listener());
  diagLog('flags', { changed: changedFlags(next), reason });
}

export function resetPreviewDiagFlags(reason = 'reset'): void {
  setPreviewDiagFlags({ ...DEFAULT_FLAGS }, reason);
}

export function usePreviewDiagFlags(): PreviewDiagFlags {
  return useSyncExternalStore(
    subscribeFlags,
    getPreviewDiagFlags,
    () => DEFAULT_FLAGS,
  );
}

// ───────────────────────── 主进程信息 ─────────────────────────

export interface PreviewDiagPreset {
  id: string;
  label: string;
  detail: string;
}

export interface PreviewDiagInfo {
  enabled: boolean;
  diagnosticBuild?: boolean;
  platform?: string;
  appVersion?: string;
  startedAt?: number;
  appliedPresetId?: string;
  pendingPresetId?: string;
  presets?: PreviewDiagPreset[];
  dir?: string;
}

let info: PreviewDiagInfo | null = null;
let infoRequest: Promise<PreviewDiagInfo> | null = null;
const infoListeners = new Set<() => void>();

function subscribeInfo(listener: () => void): () => void {
  infoListeners.add(listener);
  return () => infoListeners.delete(listener);
}

/** 向主进程问一次「诊断功能开着吗」，结果缓存。正式版返回 {enabled:false}。 */
export function loadPreviewDiagInfo(): Promise<PreviewDiagInfo> {
  infoRequest ??= (async () => {
    let loaded: PreviewDiagInfo = { enabled: false };
    try {
      const response = await window.ipc.invoke('previewDiag:info');
      if (response?.enabled) loaded = response as PreviewDiagInfo;
    } catch {
      // 没有这个通道（旧主进程）等同于未启用
    }
    info = loaded;
    if (loaded.enabled) exposeDebugHandle();
    infoListeners.forEach((listener) => listener());
    return loaded;
  })();
  return infoRequest;
}

/** 返回缓存的信息；首次使用时触发加载。未知时为 null。 */
export function usePreviewDiagInfo(): PreviewDiagInfo | null {
  useEffect(() => {
    void loadPreviewDiagInfo();
  }, []);
  return useSyncExternalStore(
    subscribeInfo,
    () => info,
    () => null,
  );
}

/** e2e 与手工排查用：诊断启用时在 window 上挂一个调试句柄。 */
function exposeDebugHandle(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__previewDiag = {
    getFlags: getPreviewDiagFlags,
    setFlags: setPreviewDiagFlags,
    reset: resetPreviewDiagFlags,
    flush: flushDiagLog,
  };
}

// ───────────────────────── 日志 ─────────────────────────

const MAX_QUEUE = 5000;
const FLUSH_BATCH = 400;
const queue: Array<Record<string, unknown>> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 记一条事件。t=墙钟毫秒（和主进程的事件对齐），p=本页 performance.now（毫秒，一位小数，
 * 和 Chromium 追踪里的 performance.mark 对齐）。诊断未启用时什么都不做。
 */
export function diagLog(
  type: string,
  data: Record<string, unknown> = {},
): void {
  if (!info?.enabled) return;
  queue.push({
    type,
    t: Date.now(),
    p: Math.round(performance.now() * 10) / 10,
    ...data,
  });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (queue.length >= 200) void flushDiagLog();
  else flushTimer ??= setTimeout(() => void flushDiagLog(), 1000);
}

export async function flushDiagLog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  while (queue.length > 0) {
    const batch = queue.splice(0, FLUSH_BATCH);
    try {
      await window.ipc.invoke('previewDiag:log', batch);
    } catch {
      // 日志写失败不能影响被诊断的功能
      return;
    }
  }
}
