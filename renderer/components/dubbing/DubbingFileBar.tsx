/**
 * 工作台文件条：字幕（必选）+ 视频（可选）+ 从最近任务导入 + 开始/取消。
 * 支持把字幕/视频文件直接拖放到条上。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  FileText,
  Film,
  X,
  Play,
  RotateCcw,
  Square,
  Loader2,
  History,
  ChevronDown,
  Info,
} from 'lucide-react';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import type { WorkItem } from '../../../types/workItem';
import { TTS_AZURE_SPEECH, TTS_ELEVENLABS } from '../../../types/ttsProvider';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa|lrc)$/i;

/** 最近任务里可导入的候选：产出字幕（优先译文）+ 可选源视频。 */
interface RecentImportCandidate {
  key: string;
  label: string;
  subtitlePath: string;
  videoPath?: string;
}

function collectRecentCandidates(items: WorkItem[]): RecentImportCandidate[] {
  const out: RecentImportCandidate[] = [];
  for (const item of items) {
    for (const f of item.pipelineFiles ?? []) {
      const subtitle = f.translatedSrtFile || f.srtFile;
      if (!subtitle) continue;
      out.push({
        key: `${item.id}:${f.uuid}`,
        label: `${f.fileName ?? baseName(f.filePath)} · ${baseName(subtitle)}`,
        subtitlePath: subtitle,
        videoPath: f.filePath,
      });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

export default function DubbingFileBar({ dub }: { dub: UseDubbingReturn }) {
  const { t } = useTranslation('dubbing');
  const {
    subtitlePath,
    videoPath,
    pickSubtitle,
    pickVideo,
    setSubtitlePath,
    setVideoPath,
    clearVideo,
    clearSubtitle,
    running,
    percent,
    start,
    cancel,
    isCancelling,
    canStart,
    summary,
    charEstimate,
    activeEngine,
    loading,
  } = dub;

  // 全部完成时按钮为「全部重跑」→ 字符量按全量口径，否则按剩余待合成口径。
  const isRedubAll = summary.total > 0 && summary.done === summary.total;
  const estRows = isRedubAll
    ? charEstimate.totalRows
    : charEstimate.pendingRows;
  const estChars = isRedubAll
    ? charEstimate.totalChars
    : charEstimate.pendingChars;
  // 云端引擎：叠加计费口径提示（Azure 含 SSML 附加 / ElevenLabs 字节膨胀）。
  const billingHint =
    activeEngine?.kind === 'cloud'
      ? [
          t('charBillingCloud'),
          activeEngine.providerType === TTS_AZURE_SPEECH
            ? t('charBillingAzure')
            : null,
          activeEngine.providerType === TTS_ELEVENLABS
            ? t('charBillingEleven')
            : null,
        ]
          .filter(Boolean)
          .join('\n')
      : undefined;

  const [recent, setRecent] = useState<RecentImportCandidate[]>([]);
  useEffect(() => {
    window.ipc
      .invoke('getWorkItems')
      .then((items: WorkItem[]) =>
        setRecent(collectRecentCandidates(items ?? [])),
      )
      .catch(() => setRecent([]));
  }, []);

  // 拖放：字幕扩展名进字幕槽，其余按视频/音频处理。
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (running) return;
      for (const file of Array.from(e.dataTransfer.files)) {
        const p = window.ipc.getPathForFile(file);
        if (!p) continue;
        if (SUBTITLE_EXT.test(p)) setSubtitlePath(p);
        else setVideoPath(p);
      }
    },
    [running, setSubtitlePath, setVideoPath],
  );

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* 字幕文件 */}
      <div className="flex items-center gap-1.5">
        <FileText className="h-4 w-4 text-muted-foreground" />
        {subtitlePath ? (
          <Badge
            variant="secondary"
            className="max-w-[260px] gap-1 font-normal"
          >
            <span className="truncate" title={subtitlePath}>
              {baseName(subtitlePath)}
            </span>
            <button
              onClick={clearSubtitle}
              disabled={running}
              aria-label={t('clearSubtitle')}
              className="ml-0.5 rounded hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ) : (
          <Button variant="outline" size="sm" onClick={pickSubtitle}>
            {t('selectSubtitle')}
          </Button>
        )}
      </div>

      {/* 视频（可选） */}
      <div className="flex items-center gap-1.5">
        <Film className="h-4 w-4 text-muted-foreground" />
        {videoPath ? (
          <Badge
            variant="secondary"
            className="max-w-[260px] gap-1 font-normal"
          >
            <span className="truncate" title={videoPath}>
              {baseName(videoPath)}
            </span>
            <button
              onClick={clearVideo}
              disabled={running}
              aria-label={t('clearVideo')}
              className="ml-0.5 rounded hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ) : (
          <Button variant="outline" size="sm" onClick={pickVideo}>
            {t('selectVideoOptional')}
          </Button>
        )}
      </div>

      {/* 从最近任务导入 */}
      {recent.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={running}>
              <History className="mr-1 h-3.5 w-3.5" />
              {t('importFromRecent')}
              <ChevronDown className="ml-0.5 h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-md">
            {recent.map((c) => (
              <DropdownMenuItem
                key={c.key}
                onClick={() => {
                  setSubtitlePath(c.subtitlePath);
                  if (c.videoPath) setVideoPath(c.videoPath);
                }}
              >
                <span className="truncate">{c.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {loading && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('loadingSubtitle')}
        </span>
      )}

      {summary.total > 0 && (
        <span className="text-xs text-muted-foreground">
          {t('cueSummary', {
            total: summary.total,
            done: summary.done,
          })}
          {summary.overlong > 0 && (
            <span className="ml-1 text-amber-600">
              {t('overlongCount', { count: summary.overlong })}
            </span>
          )}
          {summary.failed > 0 && (
            <span className="ml-1 text-destructive">
              {t('failedCount', { count: summary.failed })}
            </span>
          )}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* 合成字符量预估（发起前可见；云端引擎附计费口径提示） */}
        {!running && estRows > 0 && (
          <span
            className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
            title={billingHint}
          >
            {t('charEstimate', {
              rows: estRows,
              chars: estChars.toLocaleString(),
            })}
            {billingHint && <Info className="h-3 w-3" />}
          </span>
        )}
        {running && (
          <div className="flex w-40 items-center gap-2">
            <Progress value={percent} className="h-2" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {percent}%
            </span>
          </div>
        )}
        {running ? (
          <Button
            variant="outline"
            size="sm"
            onClick={cancel}
            disabled={isCancelling}
          >
            {isCancelling ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="mr-1 h-3.5 w-3.5" />
            )}
            {t('cancel')}
          </Button>
        ) : summary.total > 0 && summary.done === summary.total ? (
          // 全部完成：按钮转「重新合成」= 全量重跑（换 voice/语速后再来一遍）。
          <Button
            size="sm"
            variant="outline"
            onClick={() => start({ force: true })}
            disabled={!canStart}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {t('redubAll')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => start()} disabled={!canStart}>
            <Play className="mr-1 h-3.5 w-3.5" />
            {summary.done > 0 ? t('resumeDubbing') : t('startDubbing')}
          </Button>
        )}
      </div>
    </div>
  );
}
