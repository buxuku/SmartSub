/**
 * 配音工作台主面板：文件条 + 左栏配置 + 右栏（行列表 + 播放器）。
 */
import React, { useRef, useState, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useDubbing } from '../../hooks/useDubbing';
import DubbingFileBar from './DubbingFileBar';
import DubbingConfigPanel from './DubbingConfigPanel';
import DubbingCueList from './DubbingCueList';
import DubbingPlayer, { type DubbingPlayerHandle } from './DubbingPlayer';

interface DubbingPanelProps {
  initialSubtitlePath?: string;
  initialVideoPath?: string;
}

export default function DubbingPanel({
  initialSubtitlePath,
  initialVideoPath,
}: DubbingPanelProps) {
  const { t } = useTranslation('dubbing');
  const dub = useDubbing({ initialSubtitlePath, initialVideoPath });
  const playerRef = useRef<DubbingPlayerHandle>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(-1);

  const handleSeek = useCallback((ms: number) => {
    playerRef.current?.seekToMs(ms);
  }, []);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex-shrink-0">
        <DubbingFileBar dub={dub} />
      </div>

      {dub.loadError && (
        <p className="flex-shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {dub.loadError}
        </p>
      )}

      {!dub.subtitlePath ? (
        <Card className="flex flex-1 items-center justify-center">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('emptyStateHint')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(300px,340px)_1fr]">
          {/* 左栏：配置（滚动） */}
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
