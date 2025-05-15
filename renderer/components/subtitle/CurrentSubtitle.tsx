import React, { useEffect } from 'react';
import { formatTime } from '../../hooks/useVideoPlayer';
import { Subtitle } from '../../hooks/useSubtitles';
import { useTranslation } from 'next-i18next';

interface CurrentSubtitleProps {
  currentSubtitleIndex: number;
  currentTime: number;
  duration: number;
  mergedSubtitles: Subtitle[];
  shouldShowTranslation: boolean;
  hasTranslationFile: boolean;
}

const CurrentSubtitle: React.FC<CurrentSubtitleProps> = ({
  currentSubtitleIndex,
  currentTime,
  duration,
  mergedSubtitles,
  shouldShowTranslation,
  hasTranslationFile,
}) => {
  const { t } = useTranslation('home');

  // 获取当前字幕对象，添加边界检查
  const currentSubtitle =
    currentSubtitleIndex >= 0 && currentSubtitleIndex < mergedSubtitles.length
      ? mergedSubtitles[currentSubtitleIndex]
      : null;

  return (
    <div className="p-2 border rounded-md bg-muted/30 mb-2">
      <div className="flex justify-between items-center mb-1">
        <div className="text-sm">{t('currentSubtitle')}</div>
        <div className="text-xs text-gray-500">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>
      </div>

      {currentSubtitle ? (
        <div>
          <div className="text-xs text-gray-500 mb-1">
            {currentSubtitle.startEndTime}
          </div>
          {currentSubtitle.sourceContent && (
            <div className="mb-2 p-1 bg-background rounded border-l-2  text-sm">
              {currentSubtitle.sourceContent}
            </div>
          )}
          {shouldShowTranslation &&
            hasTranslationFile &&
            currentSubtitle.targetContent && (
              <div className="p-1 bg-background rounded border-l-2  text-sm">
                {currentSubtitle.targetContent}
              </div>
            )}
        </div>
      ) : (
        <div className="text-sm text-gray-500 p-2">
          {t('noCurrentSubtitle')}
        </div>
      )}
    </div>
  );
};

export default CurrentSubtitle;
