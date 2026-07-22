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
import {
  extractUrls,
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
      });
      try {
        const created: WorkItem = await window?.ipc?.invoke(
          'videoDownload:start',
          {
            name: buildBatchName(entries, entries.length),
            savePath,
            quality,
            engine: engineChoice,
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
    const paths = Array.from(selectedPaths);
    if (!paths.length) {
      toast.warning(t('task.handoffNothing'));
      return;
    }
    const wrapped: IFiles[] =
      (await window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'media',
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
  }, [selectedPaths, item, locale, router, t]);

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
        />
      )}
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
}: {
  item: WorkItem;
  videoArtifacts: WorkItemArtifact[];
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
            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/50">
              <Checkbox
                checked={
                  selectedPaths.size === videoArtifacts.length &&
                  videoArtifacts.length > 0
                }
                onCheckedChange={(v) => onToggleAll(v === true)}
              />
              {t('task.selectAll')}
            </label>
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
}: {
  entry: DownloadEntry;
  onRetry: (entryId: string, updateFirst?: boolean) => void;
  onCancel: (entryId: string) => void;
  onReveal: (path: string) => void;
}) {
  const { t } = useTranslation('download');
  const isCancelled = entry.error === 'CANCELLED';
  const maybeOutdated = Boolean(entry.error?.startsWith(MAYBE_OUTDATED_PREFIX));
  const errorText = entry.error
    ? entry.error.replace(MAYBE_OUTDATED_PREFIX, '').slice(0, 200)
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
            {maybeOutdated && (
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
            {maybeOutdated && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => onRetry(entry.id, true)}
              >
                {t('task.retryWithUpdate')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
