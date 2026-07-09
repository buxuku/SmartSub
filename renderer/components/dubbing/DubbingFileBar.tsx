/**
 * 工作台文件条：字幕（必选）+ 视频（可选）+ 从最近任务导入 + 行数统计，
 * 右端为主操作簇（开始/继续/导出 + 进度，见 DubbingActionBar）。
 * 文件拖放由 DubbingPanel 整页接管。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileText, Film, X, Loader2, History, ChevronDown } from 'lucide-react';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import type { WorkItem } from '../../../types/workItem';
import DubbingActionBar from './DubbingActionBar';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

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
    summary,
    loading,
  } = dub;

  const [recent, setRecent] = useState<RecentImportCandidate[]>([]);
  useEffect(() => {
    window.ipc
      .invoke('getWorkItems')
      .then((items: WorkItem[]) =>
        setRecent(collectRecentCandidates(items ?? [])),
      )
      .catch(() => setRecent([]));
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
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

      {/* 右上角主操作簇：开始/继续/重跑 + 导出 + 进度 */}
      {subtitlePath && (
        <div className="ml-auto">
          <DubbingActionBar dub={dub} />
        </div>
      )}
    </div>
  );
}
