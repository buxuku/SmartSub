import React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
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
}

const SubtitleList: React.FC<SubtitleListProps> = ({
  mergedSubtitles,
  currentSubtitleIndex,
  shouldShowTranslation,
  handleSubtitleClick,
  handleSubtitleChange,
}) => {
  const { t } = useTranslation('home');

  // 处理字幕点击
  const onSubtitleClick = (index: number) => {
    console.log(`点击字幕 #${index}, ID: ${mergedSubtitles[index]?.id}`);
    // 调用父组件提供的处理函数
    handleSubtitleClick(index);
  };

  return (
    <ScrollArea className="border rounded-md">
      <div className="px-1 py-0.5">
        {mergedSubtitles.map((subtitle, index) => (
          <div
            key={`${subtitle.id}-${index}`}
            id={`subtitle-${index}`}
            className={`mb-1 p-1 rounded-md transition-colors ${
              currentSubtitleIndex === index
                ? 'bg-accent'
                : 'bg-card hover:bg-accent/50'
            } text-xs`}
            onClick={() => onSubtitleClick(index)}
          >
            <div className="flex justify-between items-center text-[10px] text-gray-500 mb-0.5">
              <div>
                #{subtitle.id} · {subtitle.startEndTime}
                {currentSubtitleIndex === index && ' (当前播放)'}
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
                }`}
                value={subtitle.targetContent || ''}
                onChange={(e) =>
                  handleSubtitleChange(index, 'targetContent', e.target.value)
                }
                placeholder={t('translatedSubtitle')}
              />
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
};

export default SubtitleList;
