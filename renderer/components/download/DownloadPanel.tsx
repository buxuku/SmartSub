/**
 * 视频下载页主面板：三态流转
 * 输入（粘贴链接 + 保存配置）→ 预检确认（元数据/合集展开/失败前置）→ 任务态
 * （进度/取消/重试 → 完成交接到任务向导）。任务持久化为 download WorkItem，
 * `?workItem=` 直达任务态（最近任务/ActivityCenter 回开入口）。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cookie,
  CloudDownload,
  FolderOpen,
  ListVideo,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from 'lib/utils';
import { WIZARD_DROP_KEY } from 'lib/recipes';
import { readPersistedDownloadSource } from '@/components/settings/gpu/gpuDownloadUtils';
import EngineSetupCard from './EngineSetupCard';
import CookieProfilesDialog from './CookieProfilesDialog';
import {
  extractUrls,
  matchCookieProfile,
  type CookieProfileView,
  type DownloadEngineChoice,
  type DownloadEntry,
  type DownloadPreflightResult,
  type DownloadQuality,
  type DownloaderStatus,
} from '../../../types/download';
import type { WorkItem, WorkItemArtifact } from '../../../types/workItem';
import type { IFiles } from '../../../types';

type Phase = 'compose' | 'review' | 'task';

const LARGE_PLAYLIST_THRESHOLD = 100;
const MAYBE_OUTDATED_PREFIX = 'MAYBE_OUTDATED::';
const MAYBE_COOKIE_EXPIRED_PREFIX = 'MAYBE_COOKIE_EXPIRED::';

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function stemOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/** 目录部分（含结尾分隔符）：字幕随行按同目录同主干匹配 */
function dirOf(filePath: string): string {
  return filePath.slice(0, filePath.length - fileNameOf(filePath).length);
}

/** 预检字幕语言展示：最多 3 个，超出折叠为 +N */
function formatSubtitleLangs(langs: string[]): string {
  const shown = langs.slice(0, 3).join('/');
  const extra = langs.length - 3;
  return extra > 0 ? `${shown} +${extra}` : shown;
}

export default function DownloadPanel() {
  const router = useRouter();
  const locale =
    typeof router.query.locale === 'string' ? router.query.locale : 'zh';
  const { t } = useTranslation('download');

  // ── 引擎状态 ──────────────────────────────────────────────────────────────
  const [statuses, setStatuses] = useState<DownloaderStatus[] | null>(null);
  const refreshStatuses = useCallback(async (fetchRemote = false) => {
    try {
      const next = await window?.ipc?.invoke('videoDownload:getStatuses', {
        source: readPersistedDownloadSource(),
        fetchRemote,
      });
      setStatuses(next || []);
    } catch {
      setStatuses([]);
    }
  }, []);

  useEffect(() => {
    // 首屏先读本地（快），随后带远端清单刷新（慢，含更新检测）
    void refreshStatuses(false).then(() => refreshStatuses(true));
  }, [refreshStatuses]);

  const anyEngineInstalled = Boolean(statuses?.some((s) => s.installed));

  // ── 输入态 ────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('compose');
  const [rawText, setRawText] = useState('');
  const urls = useMemo(() => extractUrls(rawText), [rawText]);
  const [savePath, setSavePath] = useState('');
  const [quality, setQuality] = useState<DownloadQuality>('best');
  const [engineChoice, setEngineChoice] =
    useState<DownloadEngineChoice>('auto');
  const [concurrency, setConcurrency] = useState(2);
  const [writeSubs, setWriteSubs] = useState(true);

  // ── 站点 Cookie 档案 ────────────────────────────────────────────────────────
  const [cookieProfiles, setCookieProfiles] = useState<CookieProfileView[]>([]);
  const [cookieDialogOpen, setCookieDialogOpen] = useState(false);
  const [cookieFocusId, setCookieFocusId] = useState<string | null>(null);
  const loadCookieProfiles = useCallback(async () => {
    try {
      const list = await window?.ipc?.invoke(
        'videoDownload:cookieProfiles:list',
      );
      setCookieProfiles(Array.isArray(list) ? list : []);
    } catch {
      setCookieProfiles([]);
    }
  }, []);
  useEffect(() => {
    void loadCookieProfiles();
  }, [loadCookieProfiles]);
  const configuredCookieCount = useMemo(
    () => cookieProfiles.filter((p) => p.configured).length,
    [cookieProfiles],
  );
  const openCookieDialog = useCallback((focusId?: string | null) => {
    setCookieFocusId(focusId ?? null);
    setCookieDialogOpen(true);
  }, []);
  // 失败条目「重新导入 Cookie」：按条目 URL 匹配档案并聚焦
  const reimportCookieForUrl = useCallback(
    (url: string) => {
      const matched = matchCookieProfile(
        url,
        cookieProfiles.map((p) => ({
          id: p.id,
          matchDomains: p.matchDomains,
        })),
      );
      openCookieDialog(matched);
    },
    [cookieProfiles, openCookieDialog],
  );

  useEffect(() => {
    (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (settings?.videoDownloadSavePath) {
          setSavePath(settings.videoDownloadSavePath);
        }
        if (settings?.videoDownloadQuality) {
          setQuality(settings.videoDownloadQuality);
        }
        if (settings?.videoDownloadEngine) {
          setEngineChoice(settings.videoDownloadEngine);
        }
        if (settings?.videoDownloadConcurrency) {
          setConcurrency(settings.videoDownloadConcurrency);
        }
        if (settings?.videoDownloadWriteSubs === false) {
          setWriteSubs(false);
        }
      } catch {
        // 设置读取失败走默认值
      }
    })();
  }, []);

  const persistSetting = useCallback((patch: Record<string, unknown>) => {
    void window?.ipc?.invoke('setSettings', patch).catch(() => {});
  }, []);

  const choosePath = useCallback(async () => {
    const result = await window?.ipc?.invoke('selectDirectory', {});
    if (result?.directoryPath) {
      setSavePath(result.directoryPath);
      persistSetting({ videoDownloadSavePath: result.directoryPath });
    }
  }, [persistSetting]);

  // ── 预检态 ────────────────────────────────────────────────────────────────
  const [reviewUrls, setReviewUrls] = useState<string[]>([]);
  const [preflightResults, setPreflightResults] = useState<
    Record<string, DownloadPreflightResult | 'pending'>
  >({});
  /** 合集展开选择：all=整表（>100 需先确认过）；single=仅此条 */
  const [expandChoice, setExpandChoice] = useState<
    Record<string, 'all' | 'single'>
  >({});

  const runPreflight = useCallback(async () => {
    if (!urls.length) return;
    setPhase('review');
    setReviewUrls(urls);
    setExpandChoice({});
    setPreflightResults(
      Object.fromEntries(urls.map((u) => [u, 'pending' as const])),
    );
    try {
      const results: DownloadPreflightResult[] = await window?.ipc?.invoke(
        'videoDownload:preflight',
        { urls, engine: engineChoice },
      );
      setPreflightResults((prev) => {
        const next = { ...prev };
        for (const result of results || []) next[result.url] = result;
        return next;
      });
    } catch (error) {
      toast.error(String(error));
      setPhase('compose');
    }
  }, [urls, engineChoice]);

  // ── 任务态 ────────────────────────────────────────────────────────────────
  const [item, setItem] = useState<WorkItem | null>(null);
  const itemIdRef = useRef<string | null>(null);
  itemIdRef.current = item?.id ?? null;

  const loadItem = useCallback(async (id: string) => {
    const loaded: WorkItem | null = await window?.ipc?.invoke(
      'getWorkItem',
      id,
    );
    if (loaded && loaded.type === 'download') {
      setItem(loaded);
      setPhase('task');
    }
  }, []);

  // ?workItem= 直达任务态（最近任务 / ActivityCenter 回开）
  useEffect(() => {
    if (!router.isReady) return;
    const id = router.query.workItem;
    if (typeof id === 'string' && id && id !== itemIdRef.current) {
      void loadItem(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.workItem, loadItem]);

  // 实时事件：条目进度补丁 + 结构变化重取
  useEffect(() => {
    const cleanupEntry = window?.ipc?.on(
      'videoDownload:entryChanged',
      (payload: { workItemId: string; entry: DownloadEntry }) => {
        if (payload.workItemId !== itemIdRef.current) return;
        setItem((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            downloadEntries: (prev.downloadEntries || []).map((entry) =>
              entry.id === payload.entry.id ? payload.entry : entry,
            ),
          };
        });
      },
    );
    const cleanupItem = window?.ipc?.on(
      'videoDownload:itemChanged',
      (payload: { workItemId: string }) => {
        if (payload.workItemId !== itemIdRef.current) return;
        void window?.ipc
          ?.invoke('getWorkItem', payload.workItemId)
          .then((loaded: WorkItem | null) => {
            if (loaded && loaded.id === itemIdRef.current) setItem(loaded);
          });
      },
    );
    return () => {
      cleanupEntry?.();
      cleanupItem?.();
    };
  }, []);

  const buildBatchName = useCallback(
    (entries: Array<{ meta?: { title?: string } }>, total: number): string => {
      const title = entries.find((e) => e.meta?.title)?.meta?.title;
      if (!title) return t('task.batchNameFallback', { count: total });
      if (total === 1) return t('task.batchNameSingle', { title });
      return t('task.batchNameMulti', { title, count: total });
    },
    [t],
  );

  const startDownload = useCallback(
    async (
      entries: Array<{
        url: string;
        meta?: DownloadPreflightResult['meta'];
        expandPlaylist?: boolean;
      }>,
    ) => {
      if (!savePath) {
        toast.warning(t('compose.noPathHint'));
        return;
      }
      if (!entries.length) {
        toast.warning(t('review.noneSelectable'));
        return;
      }
      persistSetting({
        videoDownloadQuality: quality,
        videoDownloadEngine: engineChoice,
        videoDownloadConcurrency: concurrency,
        videoDownloadWriteSubs: writeSubs,
      });
      try {
        const created: WorkItem = await window?.ipc?.invoke(
          'videoDownload:start',
          {
            name: buildBatchName(entries, entries.length),
            savePath,
            quality,
            engine: engineChoice,
            writeSubs,
            entries,
          },
        );
        setItem(created);
        setPhase('task');
        void router.replace(
          { query: { ...router.query, workItem: created.id } },
          undefined,
          { shallow: true },
        );
      } catch (error) {
        toast.error(String(error instanceof Error ? error.message : error));
      }
    },
    [
      savePath,
      quality,
      engineChoice,
      concurrency,
      writeSubs,
      buildBatchName,
      persistSetting,
      router,
      t,
    ],
  );

  const startFromReview = useCallback(() => {
    const entries: Array<{
      url: string;
      meta?: DownloadPreflightResult['meta'];
      expandPlaylist?: boolean;
    }> = [];
    for (const url of reviewUrls) {
      const result = preflightResults[url];
      if (!result || result === 'pending' || !result.ok) continue;
      const isPlaylist = (result.meta?.playlistCount || 0) > 0;
      entries.push({
        url,
        meta: result.meta,
        expandPlaylist: isPlaylist ? expandChoice[url] === 'all' : undefined,
      });
    }
    void startDownload(entries);
  }, [reviewUrls, preflightResults, expandChoice, startDownload]);

  const startDirect = useCallback(() => {
    void startDownload(urls.map((url) => ({ url })));
  }, [urls, startDownload]);

  const resetToCompose = useCallback(() => {
    setItem(null);
    setPhase('compose');
    setRawText('');
    const { workItem: _drop, ...rest } = router.query;
    void router.replace({ query: rest }, undefined, { shallow: true });
  }, [router]);

  // ── 交接 ──────────────────────────────────────────────────────────────────
  const videoArtifacts = useMemo(
    () => (item?.artifacts || []).filter((a) => a.kind === 'video'),
    [item],
  );
  const subtitleArtifacts = useMemo(
    () => (item?.artifacts || []).filter((a) => a.kind === 'subtitle'),
    [item],
  );
  /** 视频路径 → 同目录同主干的字幕产物路径（随行交接与行内标记共用） */
  const subtitlesByVideoPath = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!subtitleArtifacts.length) return map;
    for (const video of videoArtifacts) {
      const dir = dirOf(video.path);
      const prefix = `${stemOf(fileNameOf(video.path))}.`;
      const subs = subtitleArtifacts
        .filter(
          (s) =>
            dirOf(s.path) === dir &&
            stemOf(fileNameOf(s.path)).startsWith(prefix),
        )
        .map((s) => s.path);
      if (subs.length) map.set(video.path, subs);
    }
    return map;
  }, [videoArtifacts, subtitleArtifacts]);
  /** 携带官方字幕开关（有字幕产物时展示，默认开） */
  const [carrySubs, setCarrySubs] = useState(true);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const entriesTerminal = useMemo(
    () =>
      Boolean(
        item?.downloadEntries?.length &&
          item.downloadEntries.every(
            (e) => e.status === 'done' || e.status === 'error',
          ),
      ),
    [item],
  );

  // 完成后默认全选产物
  useEffect(() => {
    if (entriesTerminal && videoArtifacts.length) {
      setSelectedPaths(new Set(videoArtifacts.map((a) => a.path)));
    }
  }, [entriesTerminal, videoArtifacts]);

  const sendToTasks = useCallback(async () => {
    const videoPaths = Array.from(selectedPaths);
    if (!videoPaths.length) {
      toast.warning(t('task.handoffNothing'));
      return;
    }
    // 字幕随行：选中视频的同主干字幕一并预填，向导侧自动配对跳过听写
    const paths = carrySubs
      ? videoPaths.flatMap((p) => [p, ...(subtitlesByVideoPath.get(p) || [])])
      : videoPaths;
    const wrapped: IFiles[] =
      (await window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'any',
      })) || [];
    if (!wrapped.length) {
      toast.error(t('task.handoffNothing'));
      return;
    }
    if (wrapped.length < paths.length) {
      toast.info(
        t('task.handoffSkipped', { count: paths.length - wrapped.length }),
      );
    }
    try {
      sessionStorage.setItem(WIZARD_DROP_KEY, JSON.stringify(wrapped));
    } catch {
      // sessionStorage 不可用时向导侧无预填，仍可手动导入
    }
    void router.push(
      `/${locale}/tasks/new?fromDownload=${encodeURIComponent(item?.id || '')}`,
    );
  }, [selectedPaths, carrySubs, subtitlesByVideoPath, item, locale, router, t]);

  // ── 任务态动作 ────────────────────────────────────────────────────────────
  const retryEntry = useCallback((entryId: string, updateFirst = false) => {
    if (!itemIdRef.current) return;
    void window?.ipc?.invoke('videoDownload:retryEntry', {
      workItemId: itemIdRef.current,
      entryId,
      updateFirst,
      source: readPersistedDownloadSource(),
    });
  }, []);

  const cancelEntry = useCallback((entryId: string) => {
    if (!itemIdRef.current) return;
    void window?.ipc?.invoke('videoDownload:cancelEntry', {
      workItemId: itemIdRef.current,
      entryId,
    });
  }, []);

  const cancelBatch = useCallback(() => {
    if (!itemIdRef.current) return;
    void window?.ipc?.invoke('videoDownload:cancelBatch', {
      workItemId: itemIdRef.current,
    });
  }, []);

  const resumeBatch = useCallback(() => {
    if (!itemIdRef.current) return;
    void window?.ipc?.invoke('videoDownload:resume', {
      workItemId: itemIdRef.current,
    });
  }, []);

  const revealFile = useCallback((filePath: string) => {
    void window?.ipc?.invoke('videoDownload:revealFile', { filePath });
  }, []);

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto p-3">
      <EngineSetupCard
        statuses={statuses}
        onStatusesChange={() => void refreshStatuses(false)}
      />

      {phase === 'compose' && (
        <Panel className="flex-none">
          <PanelHeader
            title={t('pageTitle')}
            meta={
              urls.length > 0
                ? t('compose.parsedCount', { count: urls.length })
                : undefined
            }
          />
          <div className="flex flex-col gap-2.5 p-3">
            <Textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={t('compose.placeholder')}
              className="min-h-[180px] resize-y font-mono text-xs leading-relaxed"
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="flex-shrink-0 text-muted-foreground">
                  {t('compose.savePath')}
                </span>
                <button
                  type="button"
                  onClick={choosePath}
                  className="flex min-w-0 items-center gap-1.5 rounded border bg-muted/40 px-2 py-1 transition-colors hover:bg-muted"
                >
                  <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    {savePath || t('compose.choosePath')}
                  </span>
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">
                  {t('compose.quality')}
                </span>
                <Select
                  value={quality}
                  onValueChange={(v) => setQuality(v as DownloadQuality)}
                >
                  <SelectTrigger className="h-7 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="best">
                      {t('compose.qualityBest')}
                    </SelectItem>
                    <SelectItem value="1080p">1080p</SelectItem>
                    <SelectItem value="720p">720p</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">
                  {t('compose.engine')}
                </span>
                <Select
                  value={engineChoice}
                  onValueChange={(v) =>
                    setEngineChoice(v as DownloadEngineChoice)
                  }
                >
                  <SelectTrigger className="h-7 w-40 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {t('compose.engineAuto')}
                    </SelectItem>
                    <SelectItem value="yt-dlp">yt-dlp</SelectItem>
                    <SelectItem value="lux">lux</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">
                  {t('compose.concurrency')}
                </span>
                <Select
                  value={String(concurrency)}
                  onValueChange={(v) => setConcurrency(Number(v))}
                >
                  <SelectTrigger className="h-7 w-16 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex cursor-pointer items-center gap-1.5">
                <Checkbox
                  checked={writeSubs}
                  onCheckedChange={(v) => {
                    const next = v === true;
                    setWriteSubs(next);
                    persistSetting({ videoDownloadWriteSubs: next });
                  }}
                />
                <span className="text-muted-foreground">
                  {t('compose.writeSubs')}
                </span>
              </label>
              <button
                type="button"
                onClick={() => openCookieDialog()}
                className="flex items-center gap-1.5 rounded border bg-muted/40 px-2 py-1 transition-colors hover:bg-muted"
              >
                <Cookie className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">
                  {t('cookie.entry')}
                </span>
                {configuredCookieCount > 0 && (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    {configuredCookieCount}
                  </Badge>
                )}
              </button>
            </div>
            <div className="flex items-center justify-end gap-2">
              {!anyEngineInstalled && statuses && (
                <span className="mr-auto text-xs text-warning">
                  {t('compose.needEngine')}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={!urls.length || !anyEngineInstalled || !savePath}
                onClick={startDirect}
              >
                <CloudDownload className="mr-1.5 h-4 w-4" />
                {t('compose.directBtn')}
              </Button>
              <Button
                size="sm"
                disabled={!urls.length || !anyEngineInstalled}
                onClick={() => void runPreflight()}
              >
                <Search className="mr-1.5 h-4 w-4" />
                {t('compose.preflightBtn')}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {phase === 'review' && (
        <ReviewList
          urls={reviewUrls}
          results={preflightResults}
          expandChoice={expandChoice}
          onExpandChange={(url, value) =>
            setExpandChoice((prev) => ({ ...prev, [url]: value }))
          }
          onBack={() => setPhase('compose')}
          onStart={startFromReview}
        />
      )}

      {phase === 'task' && item && (
        <TaskView
          item={item}
          videoArtifacts={videoArtifacts}
          subtitlesByVideoPath={subtitlesByVideoPath}
          carrySubs={carrySubs}
          onCarrySubsChange={setCarrySubs}
          entriesTerminal={entriesTerminal}
          selectedPaths={selectedPaths}
          onTogglePath={(path, checked) =>
            setSelectedPaths((prev) => {
              const next = new Set(prev);
              if (checked) next.add(path);
              else next.delete(path);
              return next;
            })
          }
          onToggleAll={(checked) =>
            setSelectedPaths(
              checked ? new Set(videoArtifacts.map((a) => a.path)) : new Set(),
            )
          }
          onSend={() => void sendToTasks()}
          onRetry={retryEntry}
          onCancelEntry={cancelEntry}
          onCancelBatch={cancelBatch}
          onResume={resumeBatch}
          onNewBatch={resetToCompose}
          onReveal={revealFile}
          onReimportCookie={reimportCookieForUrl}
        />
      )}

      <CookieProfilesDialog
        open={cookieDialogOpen}
        onOpenChange={(next) => {
          setCookieDialogOpen(next);
          if (!next) {
            setCookieFocusId(null);
            void loadCookieProfiles();
          }
        }}
        profiles={cookieProfiles}
        onChanged={loadCookieProfiles}
        focusProfileId={cookieFocusId}
      />
    </div>
  );
}

// ── 预检确认列表 ──────────────────────────────────────────────────────────────

function ReviewList({
  urls,
  results,
  expandChoice,
  onExpandChange,
  onBack,
  onStart,
}: {
  urls: string[];
  results: Record<string, DownloadPreflightResult | 'pending'>;
  expandChoice: Record<string, 'all' | 'single'>;
  onExpandChange: (url: string, value: 'all' | 'single') => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation('download');
  const pendingCount = urls.filter((u) => results[u] === 'pending').length;
  const okCount = urls.filter((u) => {
    const r = results[u];
    return r && r !== 'pending' && r.ok;
  }).length;

  return (
    <Panel className="flex-none">
      <PanelHeader
        title={t('review.title')}
        meta={pendingCount > 0 ? t('review.analyzing') : undefined}
        actions={
          <>
            <Button variant="ghost" size="sm" className="h-7" onClick={onBack}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              {t('review.back')}
            </Button>
            <Button
              size="sm"
              className="h-7"
              disabled={okCount === 0 || pendingCount > 0}
              onClick={onStart}
            >
              <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
              {t('review.start', { count: okCount })}
            </Button>
          </>
        }
      />
      <div className="flex flex-col divide-y">
        {urls.map((url) => {
          const result = results[url];
          if (!result) return null;
          if (result === 'pending') {
            return (
              <div key={url} className="flex items-center gap-2.5 px-3 py-2.5">
                <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" />
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {url}
                </span>
              </div>
            );
          }
          if (!result.ok) {
            return (
              <div key={url} className="flex items-start gap-2.5 px-3 py-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">{url}</div>
                  <div className="mt-0.5 text-xs text-destructive">
                    {t('review.failedTag')}
                    {result.error ? `：${result.error.slice(0, 160)}` : ''}
                  </div>
                </div>
              </div>
            );
          }
          const meta = result.meta || {};
          const isPlaylist = (meta.playlistCount || 0) > 0;
          const isLarge = (meta.playlistCount || 0) > LARGE_PLAYLIST_THRESHOLD;
          const choice = expandChoice[url] || 'single';
          return (
            <div key={url} className="flex items-start gap-2.5 px-3 py-2.5">
              {isPlaylist ? (
                <ListVideo className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-success" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs font-medium">
                    {meta.title || url}
                  </span>
                  <span className="flex flex-shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      {result.engine}
                    </Badge>
                    {meta.subtitleLangs?.length ? (
                      <Badge
                        variant="secondary"
                        className="h-4 px-1 text-[10px]"
                      >
                        {t('review.subtitleBadge', {
                          langs: formatSubtitleLangs(meta.subtitleLangs),
                        })}
                      </Badge>
                    ) : null}
                    {meta.duration ? formatDuration(meta.duration) : null}
                    {meta.heights?.length
                      ? t('review.resolutionLabel', { height: meta.heights[0] })
                      : null}
                  </span>
                </div>
                {isPlaylist && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="h-5 px-1.5 text-[10px]"
                    >
                      {t('review.playlistTag', { count: meta.playlistCount })}
                    </Badge>
                    <div className="flex overflow-hidden rounded border text-[11px]">
                      <button
                        type="button"
                        onClick={() => onExpandChange(url, 'single')}
                        className={cn(
                          'px-2 py-0.5 transition-colors',
                          choice === 'single'
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-muted',
                        )}
                      >
                        {t('review.expandSingle')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (isLarge && choice !== 'all') {
                            // 大合集要求显式确认：window.confirm 足够（无需自绘对话框）
                            if (
                              !window.confirm(t('review.largePlaylistHint'))
                            ) {
                              return;
                            }
                          }
                          onExpandChange(url, 'all');
                        }}
                        className={cn(
                          'px-2 py-0.5 transition-colors',
                          choice === 'all'
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-muted',
                        )}
                      >
                        {t('review.expandAll')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ── 任务态视图 ────────────────────────────────────────────────────────────────

function TaskView({
  item,
  videoArtifacts,
  subtitlesByVideoPath,
  carrySubs,
  onCarrySubsChange,
  entriesTerminal,
  selectedPaths,
  onTogglePath,
  onToggleAll,
  onSend,
  onRetry,
  onCancelEntry,
  onCancelBatch,
  onResume,
  onNewBatch,
  onReveal,
  onReimportCookie,
}: {
  item: WorkItem;
  videoArtifacts: WorkItemArtifact[];
  subtitlesByVideoPath: Map<string, string[]>;
  carrySubs: boolean;
  onCarrySubsChange: (checked: boolean) => void;
  entriesTerminal: boolean;
  selectedPaths: Set<string>;
  onTogglePath: (path: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onSend: () => void;
  onRetry: (entryId: string, updateFirst?: boolean) => void;
  onCancelEntry: (entryId: string) => void;
  onCancelBatch: () => void;
  onResume: () => void;
  onNewBatch: () => void;
  onReveal: (path: string) => void;
  onReimportCookie: (url: string) => void;
}) {
  const { t } = useTranslation('download');
  const entries = item.downloadEntries || [];
  const doneCount = entries.filter((e) => e.status === 'done').length;
  const running = entries.some((e) => e.status === 'loading');
  const interrupted = item.status === 'interrupted';
  const hasPending = entries.some((e) => e.status === '');

  return (
    <>
      <Panel className="flex-none">
        <PanelHeader
          title={item.name}
          meta={t('task.doneSummary', {
            done: doneCount,
            total: entries.length,
          })}
          actions={
            <>
              {(running || (hasPending && !interrupted)) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={onCancelBatch}
                >
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  {t('task.cancelBatch')}
                </Button>
              )}
              {interrupted && hasPending && (
                <Button size="sm" className="h-7" onClick={onResume}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  {t('task.resume')}
                </Button>
              )}
              {/* 终态给「返回」（不需要后续处理直接回输入态）；执行中给「新建下载」
                  （批次在主进程继续跑，可另起一批） */}
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={onNewBatch}
              >
                {entriesTerminal ? (
                  <>
                    <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                    {t('task.back')}
                  </>
                ) : (
                  <>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t('task.newBatch')}
                  </>
                )}
              </Button>
            </>
          }
        />
        <div className="flex flex-col divide-y">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onRetry={onRetry}
              onCancel={onCancelEntry}
              onReveal={onReveal}
              onReimportCookie={onReimportCookie}
            />
          ))}
        </div>
      </Panel>

      {entriesTerminal && videoArtifacts.length > 0 && (
        <Panel className="flex-none border-primary/30 bg-primary/[0.03]">
          <PanelHeader
            title={t('task.handoffTitle')}
            meta={t('task.handoffDesc')}
            actions={
              <Button
                size="sm"
                className="h-7"
                disabled={selectedPaths.size === 0}
                onClick={onSend}
              >
                {t('task.sendToTasks', { count: selectedPaths.size })}
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            }
          />
          <div className="flex flex-col gap-1 p-2">
            <div className="flex items-center justify-between gap-2 px-1.5">
              <label className="flex cursor-pointer items-center gap-2 rounded py-1 text-xs text-muted-foreground hover:bg-muted/50">
                <Checkbox
                  checked={
                    selectedPaths.size === videoArtifacts.length &&
                    videoArtifacts.length > 0
                  }
                  onCheckedChange={(v) => onToggleAll(v === true)}
                />
                {t('task.selectAll')}
              </label>
              {subtitlesByVideoPath.size > 0 && (
                <label className="flex cursor-pointer items-center gap-2 rounded py-1 text-xs text-muted-foreground hover:bg-muted/50">
                  <Checkbox
                    checked={carrySubs}
                    onCheckedChange={(v) => onCarrySubsChange(v === true)}
                  />
                  {t('task.carrySubs')}
                </label>
              )}
            </div>
            {videoArtifacts.map((artifact) => (
              <label
                key={artifact.path}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50"
              >
                <Checkbox
                  checked={selectedPaths.has(artifact.path)}
                  onCheckedChange={(v) =>
                    onTogglePath(artifact.path, v === true)
                  }
                />
                <span className="min-w-0 flex-1 truncate">
                  {fileNameOf(artifact.path)}
                </span>
                {carrySubs && subtitlesByVideoPath.has(artifact.path) && (
                  <Badge
                    variant="secondary"
                    className="h-4 flex-shrink-0 px-1 text-[10px]"
                  >
                    {t('task.subtitleRideTag')}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    onReveal(artifact.path);
                  }}
                  className="flex-shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={t('task.reveal')}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              </label>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

function EntryRow({
  entry,
  onRetry,
  onCancel,
  onReveal,
  onReimportCookie,
}: {
  entry: DownloadEntry;
  onRetry: (entryId: string, updateFirst?: boolean) => void;
  onCancel: (entryId: string) => void;
  onReveal: (path: string) => void;
  onReimportCookie: (url: string) => void;
}) {
  const { t } = useTranslation('download');
  const isCancelled = entry.error === 'CANCELLED';
  const maybeOutdated = Boolean(entry.error?.startsWith(MAYBE_OUTDATED_PREFIX));
  const maybeCookieExpired = Boolean(
    entry.error?.startsWith(MAYBE_COOKIE_EXPIRED_PREFIX),
  );
  const errorText = entry.error
    ? entry.error
        .replace(MAYBE_OUTDATED_PREFIX, '')
        .replace(MAYBE_COOKIE_EXPIRED_PREFIX, '')
        .slice(0, 200)
    : '';

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <span className="mt-0.5 flex-shrink-0">
        {entry.status === 'loading' ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : entry.status === 'done' ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : entry.status === 'error' ? (
          <AlertCircle className="h-4 w-4 text-destructive" />
        ) : (
          <span className="block h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">
            {entry.meta?.title || entry.url}
          </span>
          <Badge
            variant="outline"
            className="h-4 flex-shrink-0 px-1 text-[10px] text-muted-foreground"
          >
            {entry.engine}
          </Badge>
          {entry.subtitlePaths?.length ? (
            <Badge
              variant="secondary"
              className="h-4 flex-shrink-0 px-1 text-[10px]"
            >
              {t('task.subtitleTag')}
            </Badge>
          ) : null}
        </div>
        {entry.status === 'loading' && (
          <div className="mt-1.5 flex items-center gap-2">
            <Progress value={entry.progress || 0} className="h-1 flex-1" />
            <span className="flex-shrink-0 font-mono text-[11px] text-muted-foreground">
              {Math.round(entry.progress || 0)}%
              {entry.speed ? ` · ${entry.speed}` : ''}
              {entry.eta ? ` · ${entry.eta}` : ''}
            </span>
          </div>
        )}
        {entry.status === '' && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t('task.statusWaiting')}
          </div>
        )}
        {entry.status === 'done' && entry.outputPath && (
          <button
            type="button"
            onClick={() => onReveal(entry.outputPath!)}
            className="mt-0.5 block max-w-full truncate text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {fileNameOf(entry.outputPath)}
          </button>
        )}
        {entry.status === 'error' && (
          <div className="mt-0.5 text-[11px] text-destructive">
            {isCancelled ? t('task.statusCancelled') : errorText}
            {maybeCookieExpired && (
              <span className="ml-1 text-muted-foreground">
                （{t('cookie.maybeExpiredHint')}）
              </span>
            )}
            {maybeOutdated && !maybeCookieExpired && (
              <span className="ml-1 text-muted-foreground">
                （{t('task.maybeOutdatedHint')}）
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        {entry.status === 'loading' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={() => onCancel(entry.id)}
          >
            {t('task.cancelEntry')}
          </Button>
        )}
        {entry.status === 'error' && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onRetry(entry.id)}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t('task.retry')}
            </Button>
            {maybeOutdated && !maybeCookieExpired && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => onRetry(entry.id, true)}
              >
                {t('task.retryWithUpdate')}
              </Button>
            )}
            {maybeCookieExpired && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => onReimportCookie(entry.url)}
              >
                <Cookie className="mr-1 h-3 w-3" />
                {t('cookie.reimport')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
