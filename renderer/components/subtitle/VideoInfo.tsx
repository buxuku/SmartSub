import React from 'react';
import { FileVideo } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { formatTime } from '../../hooks/useVideoPlayer';
import { SubtitleStats } from '../../hooks/useSubtitles';
import { useTranslation } from 'next-i18next';

interface VideoInfoProps {
  fileName: string;
  extension: string;
  duration: number;
  subtitleStats: SubtitleStats;
  shouldShowTranslation: boolean;
}

const VideoInfo: React.FC<VideoInfoProps> = ({
  fileName,
  extension,
  duration,
  subtitleStats,
  shouldShowTranslation,
}) => {
  const { t } = useTranslation('home');

  return (
    <div className="p-2 border rounded-md bg-muted/30">
      <div className="text-sm mb-1">{t('fileInfo')}</div>
      <div className="grid grid-cols-2 gap-1 text-xs">
        <div className="flex items-center gap-1">
          <FileVideo className="h-3 w-3" />
          <span className="truncate" title={fileName}>
            {fileName || t('unknown')} ({extension || t('unknown')})
          </span>
        </div>
        <div>
          {t('duration')}: {formatTime(duration)}
        </div>
      </div>
      <Separator className="my-2" />
      <div className="text-sm mb-1">{t('subtitleStats')}</div>
      <div className="grid grid-cols-3 gap-1 text-xs">
        <div>
          {t('total')}: {subtitleStats.total}
        </div>
        {shouldShowTranslation && (
          <>
            <div>
              {t('translated')}: {subtitleStats.withTranslation}
            </div>
            <div>
              {t('completionRate')}: {subtitleStats.percent}%
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default VideoInfo;
