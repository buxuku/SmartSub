/**
 * 配音工作台主面板：文件条（含右端主操作簇）+ 通知横幅（错误/过长预警/导出结果）
 * + 左栏配置 + 右栏（行列表 + 播放器）。
 */
import React, { useRef, useState, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  FileText,
  Mic2,
  Download,
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  X,
} from 'lucide-react';
import { useDubbing } from '../../hooks/useDubbing';
import type { DubbingExportView } from '../../../types/dubbing';
import StepGuide from '@/components/StepGuide';
import DubbingFileBar from './DubbingFileBar';
import DubbingConfigPanel from './DubbingConfigPanel';
import DubbingCueList from './DubbingCueList';
import DubbingPlayer, { type DubbingPlayerHandle } from './DubbingPlayer';

interface DubbingPanelProps {
  initialSubtitlePath?: string;
  initialVideoPath?: string;
}

const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa|lrc)$/i;

export default function DubbingPanel({
  initialSubtitlePath,
  initialVideoPath,
}: DubbingPanelProps) {
  const { t } = useTranslation('dubbing');
  const dub = useDubbing({ initialSubtitlePath, initialVideoPath });
  const playerRef = useRef<DubbingPlayerHandle>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(-1);
  // 导出结果横幅可手动关闭（按对象身份记忆；新一次导出再次展示）。
  const [dismissedResult, setDismissedResult] =
    useState<DubbingExportView | null>(null);

  const handleSeek = useCallback((ms: number) => {
    playerRef.current?.seekToMs(ms);
  }, []);

  const { running, setSubtitlePath, setVideoPath } = dub;
  // 拖放（整页有效，含空态）：字幕扩展名进字幕槽，其余按视频/音频处理。
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
      <div className="flex-shrink-0">
        <DubbingFileBar dub={dub} />
      </div>

      {dub.loadError && (
        <p className="flex-shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {dub.loadError}
        </p>
      )}

      {dub.actionError && (
        <p className="flex-shrink-0 break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {dub.actionError}
        </p>
      )}

      {/* 过长行未处理：导出前的预警 */}
      {!dub.running && dub.summary.overlong > 0 && (
        <p className="flex flex-shrink-0 items-start gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('overlongExportHint', { count: dub.summary.overlong })}
        </p>
      )}

      {/* 导出结果横幅：紧邻文件条，始终可见、可关闭 */}
      {dub.exportResult && dub.exportResult !== dismissedResult && (
        <div className="flex flex-shrink-0 items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
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
              <p className="text-amber-600">
                {t('exportSkipped', {
                  count: dub.exportResult.skippedIndexes.length,
                })}
              </p>
            )}
          </div>
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

      {!dub.subtitlePath ? (
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
          <div className="flex min-h-0 flex-col gap-3">
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
