/**
 * 配音工作台主面板：文件条（含右端主操作簇）+ 通知横幅（错误/过长预警/导出结果）
 * + 左栏配置 + 右栏（行列表 + 播放器）。
 */
import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import { useRouter } from 'next/router';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  FileText,
  Mic2,
  Download,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight as ChevronRightIcon,
  Diamond,
  FolderOpen,
  History,
  Clapperboard,
  Play,
  X,
  RotateCcw,
} from 'lucide-react';
import { useDubbing } from '../../hooks/useDubbing';
import { getWorkItemTarget } from 'lib/workItemUtils';
import { releasePipelineGate } from 'lib/pipelineGate';
import type { DubbingExportView } from '../../../types/dubbing';
import StepGuide from '@/components/StepGuide';
import DubbingFileBar from './DubbingFileBar';
import DubbingConfigPanel from './DubbingConfigPanel';
import DubbingCueList from './DubbingCueList';
import DubbingSpeakerVoices from './DubbingSpeakerVoices';
import DubbingPlayer, { type DubbingPlayerHandle } from './DubbingPlayer';

interface DubbingPanelProps {
  initialSubtitlePath?: string;
  initialVideoPath?: string;
  /** 最近任务回开：尝试恢复的持久化会话 */
  initialSessionId?: string;
  initialProofreadDataFile?: string;
  /** 关联的工作项 id */
  workItemId?: string;
  /** 检查员模式：配音确认检查点的流水线上下文（任务 id + 文件 uuid） */
  gateProject?: string;
  gateFile?: string;
}

const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa|lrc)$/i;
const VIDEO_OUTPUT_EXT = /\.(mp4|mkv|mov|avi|webm|m4v|ts|flv)$/i;

export default function DubbingPanel({
  initialSubtitlePath,
  initialVideoPath,
  initialSessionId,
  initialProofreadDataFile,
  workItemId,
  gateProject,
  gateFile,
}: DubbingPanelProps) {
  const { t } = useTranslation('dubbing');
  const router = useRouter();
  const locale =
    typeof router.query.locale === 'string' ? router.query.locale : 'zh';
  const inspector = Boolean(gateProject && gateFile);
  const dub = useDubbing({
    initialSubtitlePath,
    initialVideoPath,
    initialSessionId,
    initialProofreadDataFile,
    workItemId,
  });
  const playerRef = useRef<DubbingPlayerHandle>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(-1);

  // ── 检查员模式：待检清单每次动作前实时拉取（不缓存陈旧状态）──────────────
  const [reviewQueue, setReviewQueue] = useState<any[]>([]);
  const [inspectorTaskName, setInspectorTaskName] = useState('');
  const [releaseAllOpen, setReleaseAllOpen] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const releaseToken = useRef<object>();
  useEffect(() => {
    releaseToken.current = undefined;
    setReleasing(false);
    setReleaseError(null);
    return () => {
      releaseToken.current = undefined;
    };
  }, [gateProject, gateFile, dub.session?.leaseId]);
  const refreshReviewQueue = useCallback(async (): Promise<any[]> => {
    if (!gateProject) return [];
    try {
      const item = await window.ipc.invoke('getWorkItem', gateProject);
      const queue = (item?.pipelineFiles ?? []).filter(
        (f: any) => f?.dubbingGate === 'review',
      );
      setReviewQueue(queue);
      setInspectorTaskName(item?.name || '');
      return queue;
    } catch {
      return [];
    }
  }, [gateProject]);
  useEffect(() => {
    if (inspector) refreshReviewQueue();
  }, [inspector, gateFile, refreshReviewQueue]);

  const backToTask = useCallback(async () => {
    if (!gateProject) return;
    try {
      const item = await window.ipc.invoke('getWorkItem', gateProject);
      router.push(item ? getWorkItemTarget(item, locale) : `/${locale}/home`);
    } catch {
      router.push(`/${locale}/home`);
    }
  }, [gateProject, router, locale]);

  const gotoReviewFile = useCallback(
    (file: any) => {
      if (!gateProject) return;
      const params = new URLSearchParams();
      if (file?.dubbingSessionId) params.set('session', file.dubbingSessionId);
      params.set('gateProject', gateProject);
      params.set('gateFile', file?.uuid || '');
      router.replace(`/${locale}/dubbing?${params.toString()}`);
    },
    [gateProject, router, locale],
  );

  const currentReviewIndex = reviewQueue.findIndex((f) => f?.uuid === gateFile);

  const releaseAndNext = useCallback(async () => {
    if (!gateProject || !gateFile || releaseToken.current || !dub.canExport)
      return;
    const token = {};
    releaseToken.current = token;
    setReleasing(true);
    setReleaseError(null);
    try {
      await releasePipelineGate(
        {
          projectId: gateProject,
          gate: 'dubbing',
          fileUuids: [gateFile],
          leaseId: dub.session?.leaseId,
        },
        () => releaseToken.current === token,
        setReleaseError,
      );
      setReleaseError(null);
      const queue = await refreshReviewQueue();
      if (releaseToken.current !== token) return;
      const next = queue.find((f: any) => f?.uuid !== gateFile);
      if (next) gotoReviewFile(next);
      else backToTask();
    } catch (error) {
      if (releaseToken.current === token) setReleaseError(String(error));
    } finally {
      if (releaseToken.current === token) {
        releaseToken.current = undefined;
        setReleasing(false);
      }
    }
  }, [
    gateProject,
    gateFile,
    refreshReviewQueue,
    gotoReviewFile,
    backToTask,
    releasing,
    dub.canExport,
    dub.session?.leaseId,
  ]);

  const releaseAllDubbing = useCallback(async () => {
    if (!gateProject || releaseToken.current || dub.configBlocked) return;
    const token = {};
    releaseToken.current = token;
    setReleasing(true);
    setReleaseError(null);
    try {
      await releasePipelineGate(
        {
          projectId: gateProject,
          gate: 'dubbing',
          leaseId: dub.session?.leaseId,
        },
        () => releaseToken.current === token,
        setReleaseError,
      );
      backToTask();
    } catch (error) {
      if (releaseToken.current === token) setReleaseError(String(error));
    } finally {
      if (releaseToken.current === token) {
        releaseToken.current = undefined;
        setReleasing(false);
      }
    }
  }, [
    gateProject,
    backToTask,
    releasing,
    dub.configBlocked,
    dub.session?.leaseId,
  ]);
  // 导出结果横幅可手动关闭（按对象身份记忆；新一次导出再次展示）。
  const [dismissedResult, setDismissedResult] =
    useState<DubbingExportView | null>(null);

  const handleSeek = useCallback((ms: number) => {
    playerRef.current?.seekToMs(ms);
  }, []);

  // 导出产物为视频时提供「去合成」衔接：顺延字幕优先，其次会话原字幕
  const exportedVideo =
    dub.exportResult && VIDEO_OUTPUT_EXT.test(dub.exportResult.outputPath)
      ? dub.exportResult.outputPath
      : null;
  const goCompose = useCallback(() => {
    if (!exportedVideo) return;
    const subtitle = dub.exportResult?.shiftedSubtitlePath || dub.subtitlePath;
    const params = new URLSearchParams({ video: exportedVideo });
    if (subtitle) params.set('subtitle', subtitle);
    router.push(`/${locale}/subtitleMerge?${params.toString()}`);
  }, [exportedVideo, dub.exportResult, dub.subtitlePath, router, locale]);

  const { running, exporting, speakerUpdating, setSubtitlePath, setVideoPath } =
    dub;
  // 拖放（整页有效，含空态）：字幕扩展名进字幕槽，其余按视频/音频处理。
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (running || exporting || speakerUpdating || dub.configBlocked) return;
      for (const file of Array.from(e.dataTransfer.files)) {
        const p = window.ipc.getPathForFile(file);
        if (!p) continue;
        if (SUBTITLE_EXT.test(p)) setSubtitlePath(p);
        else setVideoPath(p);
      }
    },
    [
      running,
      exporting,
      speakerUpdating,
      dub.configBlocked,
      setSubtitlePath,
      setVideoPath,
    ],
  );

  const steps = [
    { icon: FileText, title: t('emptyStep1'), desc: t('emptyStep1Desc') },
    { icon: Mic2, title: t('emptyStep2'), desc: t('emptyStep2Desc') },
    { icon: Download, title: t('emptyStep3'), desc: t('emptyStep3Desc') },
  ];

  return (
    <div
      className="flex h-full flex-col gap-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* 检查员上下文条：任务定位 + 待检导航 + 放行动线 */}
      {inspector && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/[0.06] px-3 py-2">
          <Diamond className="h-3.5 w-3.5 flex-none text-warning" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {currentReviewIndex < 0
              ? t('inspector.repair')
              : t('inspector.label', {
                  index: Math.max(currentReviewIndex, 0) + 1,
                  total: Math.max(reviewQueue.length, 1),
                })}
            {inspectorTaskName && (
              <span className="ml-2 text-muted-foreground">
                {inspectorTaskName}
              </span>
            )}
          </span>
          <div className="flex flex-none items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={currentReviewIndex <= 0 || releasing}
              onClick={() =>
                gotoReviewFile(reviewQueue[currentReviewIndex - 1])
              }
            >
              <ChevronLeft className="h-3 w-3" />
              {t('inspector.prev')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={
                currentReviewIndex < 0 ||
                releasing ||
                currentReviewIndex >= reviewQueue.length - 1
              }
              onClick={() =>
                gotoReviewFile(reviewQueue[currentReviewIndex + 1])
              }
            >
              {t('inspector.next')}
              <ChevronRightIcon className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={
                currentReviewIndex < 0 ||
                !dub.canExport ||
                releasing ||
                dub.running ||
                dub.exporting
              }
              onClick={releaseAndNext}
            >
              <Play className="h-3 w-3" />
              {reviewQueue.length > 1
                ? t('inspector.releaseAndNext')
                : t('inspector.releaseAndFinish')}
            </Button>
            {reviewQueue.length > 1 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={releasing || dub.configBlocked}
                onClick={() => setReleaseAllOpen(true)}
              >
                {t('inspector.releaseAll')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={backToTask}
            >
              {t('inspector.backToTask')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-shrink-0">
        <DubbingFileBar dub={dub} hideExport={inspector} />
      </div>

      {dub.loadError && (
        <p
          role="alert"
          className="flex-shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {dub.loadError}
        </p>
      )}

      {dub.sessionLocked && (
        <p
          role="alert"
          className="flex-shrink-0 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {t('sessionLocked')}
        </p>
      )}

      {/* 会话恢复成功：行级进度已回填的提示 */}
      {dub.restoredFromSession && dub.summary.done > 0 && (
        <p className="flex flex-shrink-0 items-start gap-1.5 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
          <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('sessionRestored', {
            done: dub.summary.done,
            total: dub.summary.total,
          })}
        </p>
      )}

      {releaseError && (
        <div
          role="alert"
          className="shrink-0 break-words bg-destructive/10 p-2 text-xs text-destructive"
        >
          {t(
            releasing
              ? 'common:gateRelease.pending'
              : 'common:gateRelease.failed',
          )}
          <details className="mt-1">
            <summary>{t('common:gateRelease.details')}</summary>
            <p className="break-words">{releaseError}</p>
          </details>
        </div>
      )}
      {dub.configRecovery && !dub.loading && (
        <div
          role="alert"
          className="flex flex-shrink-0 flex-wrap items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <History className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p>
              {t(
                dub.configRecovery === 'unreadable'
                  ? 'configDraftUnreadable'
                  : 'configDraftFound',
              )}
            </p>
            {dub.configRecovery !== 'unreadable' && (
              <p className="mt-1 break-words">
                {t('configDraftSummary', {
                  voice:
                    dub.configRecovery.current.voice ||
                    dub.configRecovery.current.engineKey,
                  speed: dub.configRecovery.current.globalSpeed,
                })}
              </p>
            )}
            {dub.configError && (
              <details className="mt-1 break-all">
                <summary>{t('configErrorDetails')}</summary>
                {dub.configError}
              </details>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={dub.running || dub.exporting || dub.configSaving}
            onClick={
              dub.configRecovery === 'unreadable'
                ? dub.retryConfigDraft
                : dub.restoreConfigDraft
            }
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            {t(
              dub.configRecovery === 'unreadable'
                ? 'configDraftRetry'
                : 'configDraftRestore',
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={dub.running || dub.exporting || dub.configSaving}
            onClick={dub.discardConfig}
          >
            <X className="mr-1 h-3 w-3" />
            {t('configDraftDiscard')}
          </Button>
        </div>
      )}
      {dub.configError && !dub.configRecovery && (
        <div
          role="alert"
          className="flex flex-shrink-0 items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p>{t('configSaveFailed')}</p>
            <details className="mt-1 break-all">
              <summary className="cursor-pointer">
                {t('configErrorDetails')}
              </summary>
              {dub.configError}
            </details>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={dub.configSaving}
            onClick={dub.saveConfig}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            {t('configRetry')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={dub.configSaving}
            onClick={dub.discardConfig}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            {t('configDiscard')}
          </Button>
        </div>
      )}
      {dub.configSaving && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('configSaving')}
        </p>
      )}
      {dub.actionError && (
        <p
          role="alert"
          className="flex-shrink-0 break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {dub.actionError}
        </p>
      )}

      {/* 过长行未处理：导出前的预警 */}
      {!dub.running && dub.summary.overlong > 0 && (
        <p className="flex flex-shrink-0 items-start gap-1.5 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('overlongExportHint', { count: dub.summary.overlong })}
        </p>
      )}

      {!dub.running && dub.summary.needsUpdate > 0 && (
        <div className="flex flex-shrink-0 items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {t('staleAudioHint', { count: dub.summary.needsUpdate })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={!dub.canStart}
            onClick={dub.regenerateStale}
          >
            <RotateCcw className="h-3 w-3" />
            {t('regenerateAllStale')}
          </Button>
        </div>
      )}

      {/* 导出结果横幅：紧邻文件条，始终可见、可关闭 */}
      {dub.exportResult && dub.exportResult !== dismissedResult && (
        <div className="flex flex-shrink-0 items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="font-medium">{t('exportDone')}</p>
            <p className="break-all text-muted-foreground">
              {dub.exportResult.outputPath}
            </p>
            {dub.exportResult.shiftedSubtitlePath && (
              <p className="break-all text-muted-foreground">
                {dub.exportResult.shiftedSubtitlePath}
              </p>
            )}
            {dub.exportResult.skippedIndexes.length > 0 && (
              <p className="text-warning">
                {t('exportSkipped', {
                  count: dub.exportResult.skippedIndexes.length,
                })}
              </p>
            )}
          </div>
          {/* 视频形态导出：一键去合成（预填产出视频 + 顺延/原字幕烧字幕） */}
          {exportedVideo && (
            <Button size="sm" className="h-7 shrink-0" onClick={goCompose}>
              <Clapperboard className="mr-1 h-3.5 w-3.5" />
              {t('goCompose')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            onClick={dub.openOutputFolder}
          >
            <FolderOpen className="mr-1 h-3.5 w-3.5" />
            {t('openFolder')}
          </Button>
          <button
            aria-label={t('dismiss')}
            title={t('dismiss')}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setDismissedResult(dub.exportResult)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 检查员模式：全部放行二次确认 */}
      <AlertDialog open={releaseAllOpen} onOpenChange={setReleaseAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('inspector.releaseAllTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('inspector.releaseAllDesc', { count: reviewQueue.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('inspector.releaseAllCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={releasing || dub.configBlocked}
              onClick={() => {
                setReleaseAllOpen(false);
                releaseAllDubbing();
              }}
            >
              {t('inspector.releaseAllConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 字幕已变：重建确认（保留旧产物直至确认） */}
      <AlertDialog open={Boolean(dub.staleRestore)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('staleSessionTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('staleSessionDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={dub.cancelRebuild}>
              {t('staleSessionCancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={dub.confirmRebuild}>
              {t('staleSessionRebuild')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={dub.staleExportWarning}
        onOpenChange={(open) => {
          if (!open) dub.cancelStaleExport();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('staleExportTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('staleExportDesc', { count: dub.summary.needsUpdate })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={dub.cancelStaleExport}>
              {t('staleExportCancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={dub.confirmStaleRegeneration}>
              {t('regenerateAllStale')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {dub.sessionLocked ? null : !dub.subtitlePath ? (
        /* 空态：统一三步引导组件 + 直接选文件 */
        <Card className="flex flex-1 items-center justify-center">
          <StepGuide
            steps={steps}
            actions={
              <Button onClick={dub.pickSubtitle}>
                <FileText className="h-4 w-4" />
                {t('selectSubtitle')}
              </Button>
            }
            dropHint={t('emptyDropHint')}
          />
        </Card>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(300px,340px)_1fr]">
          {/* 左栏：配置（整列滚动） */}
          <Card className="flex min-h-0 flex-col overflow-hidden">
            <CardContent className="min-h-0 flex-1 p-0">
              <ScrollArea className="h-full">
                <DubbingConfigPanel dub={dub} />
              </ScrollArea>
            </CardContent>
          </Card>

          {/* 右栏：播放器（有视频时）+ 行列表 */}
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            {dub.speakers.length > 0 && <DubbingSpeakerVoices dub={dub} />}
            {dub.videoPath && (
              <Card className="flex-shrink-0 overflow-hidden">
                <DubbingPlayer
                  ref={playerRef}
                  videoPath={dub.videoPath}
                  onProgressMs={setCurrentTimeMs}
                />
              </Card>
            )}
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <CardContent className="min-h-0 flex-1 p-0">
                <DubbingCueList
                  dub={dub}
                  currentTimeMs={dub.videoPath ? currentTimeMs : -1}
                  onSeek={dub.videoPath ? handleSeek : undefined}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
