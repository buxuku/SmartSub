import React, { useEffect, useRef } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ChevronUp, ChevronDown, AlertTriangle } from 'lucide-react';
import { Subtitle } from '../../hooks/useSubtitles';
import { useTranslation } from 'next-i18next';

interface SubtitleListProps {
  mergedSubtitles: Subtitle[];
  currentSubtitleIndex: number;
  shouldShowTranslation: boolean;
  handleSubtitleClick: (index: number) => void;
  handleSubtitleChange: (
    index: number,
    field: 'sourceContent' | 'targetContent',
    value: string,
  ) => void;
  isTranslationFailed: (subtitle: Subtitle) => boolean;
  getFailedTranslationIndices: () => number[];
  goToNextFailedTranslation: () => void;
  goToPreviousFailedTranslation: () => void;
}

const SubtitleList: React.FC<SubtitleListProps> = ({
  mergedSubtitles,
  currentSubtitleIndex,
  shouldShowTranslation,
  handleSubtitleClick,
  handleSubtitleChange,
  isTranslationFailed,
  getFailedTranslationIndices,
  goToNextFailedTranslation,
  goToPreviousFailedTranslation,
}) => {
  const { t } = useTranslation('home');

  // 获取翻译失败的字幕索引
  const failedIndices = getFailedTranslationIndices();
  const hasFailedTranslations = failedIndices.length > 0;

  // 滚动容器引用
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 处理字幕点击
  const onSubtitleClick = (index: number) => {
    console.log(`点击字幕 #${index}, ID: ${mergedSubtitles[index]?.id}`);
    // 调用父组件提供的处理函数
    handleSubtitleClick(index);
  };

  // 自动滚动到当前字幕
  useEffect(() => {
    if (currentSubtitleIndex >= 0 && scrollContainerRef.current) {
      const element = document.getElementById(
        `subtitle-${currentSubtitleIndex}`,
      );
      if (element) {
        const container = scrollContainerRef.current;

        // 计算元素相对于容器的位置
        const elementTop = element.offsetTop;
        const elementHeight = element.offsetHeight;
        const containerHeight = container.clientHeight;

        // 将元素滚动到容器中央
        const scrollTop = elementTop - containerHeight / 2 + elementHeight / 2;

        container.scrollTo({
          top: scrollTop,
          behavior: 'smooth',
        });
      }
    }
  }, [currentSubtitleIndex]);

  return (
    <div className="h-full flex flex-col border rounded-md overflow-hidden">
      {/* 翻译失败导航栏 */}
      {shouldShowTranslation && (
        <div className="flex items-center justify-between p-2 border-b bg-muted/30 flex-shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span>
              {t('translationFailed')}: {failedIndices.length} /{' '}
              {mergedSubtitles.length}
            </span>
          </div>
          {hasFailedTranslations && (
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={goToPreviousFailedTranslation}
                className="h-7 px-2"
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={goToNextFailedTranslation}
                className="h-7 px-2"
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 字幕列表 */}
      <div className="flex-1 overflow-y-auto" ref={scrollContainerRef}>
        <div className="px-1 py-0.5">
          {mergedSubtitles.map((subtitle, index) => {
            const isFailed = isTranslationFailed(subtitle);

            return (
              <div
                key={`${subtitle.id}-${index}`}
                id={`subtitle-${index}`}
                className={`mb-1 p-1 rounded-md transition-colors cursor-pointer ${
                  currentSubtitleIndex === index
                    ? 'bg-accent'
                    : isFailed
                      ? 'bg-red-50 hover:bg-red-100 border border-red-200'
                      : 'bg-card hover:bg-accent/50'
                } text-xs ${isFailed ? 'ring-1 ring-red-300' : ''}`}
                onClick={() => onSubtitleClick(index)}
              >
                <div className="flex justify-between items-center text-[10px] text-gray-500 mb-0.5">
                  <div className="flex items-center gap-1">
                    {isFailed && (
                      <AlertTriangle className="h-3 w-3 text-red-500" />
                    )}
                    <span>
                      #{subtitle.id} · {subtitle.startEndTime}
                      {currentSubtitleIndex === index &&
                        ` ${t('currentPlaying')}`}
                      {isFailed && ` ${t('translationFailedLabel')}`}
                    </span>
                  </div>
                </div>

                <Textarea
                  className="min-h-[24px] mb-2 text-xs p-1 resize-none"
                  value={subtitle.sourceContent}
                  onChange={(e) =>
                    handleSubtitleChange(index, 'sourceContent', e.target.value)
                  }
                  placeholder={t('originalSubtitle')}
                />

                {/* 只在需要显示翻译内容时显示翻译字幕框 */}
                {shouldShowTranslation && (
                  <Textarea
                    className={`text-xs p-1 resize-none ${
                      subtitle.targetContent ? 'min-h-[24px]' : 'min-h-[20px]'
                    } ${isFailed ? 'border-red-300 focus:border-red-500' : ''}`}
                    value={subtitle.targetContent || ''}
                    onChange={(e) =>
                      handleSubtitleChange(
                        index,
                        'targetContent',
                        e.target.value,
                      )
                    }
                    placeholder={
                      isFailed
                        ? t('translationFailedPlaceholder')
                        : t('translatedSubtitle')
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default SubtitleList;
