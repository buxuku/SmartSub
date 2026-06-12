import React, { useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Sparkles,
  Scissors,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
  onCursorPositionChange?: (position: number) => void;
  onAiOptimizeClick?: (index: number) => void;
  onSplitClick?: (index: number) => void;
}

interface RowLabels {
  currentPlaying: string;
  translationFailedLabel: string;
  originalSubtitle: string;
  translatedSubtitle: string;
  translationFailedPlaceholder: string;
  aiOptimize: string;
  split: string;
}

// 秒数 → 紧凑时间（m:ss 或 h:mm:ss），用于紧凑行
const compactTime = (seconds: number | undefined): string => {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// 多行文本压成单行预览
const toPreview = (text: string | undefined): string =>
  (text || '').replace(/\s*\n\s*/g, ' ').trim();

interface SubtitleRowProps {
  subtitle: Subtitle;
  index: number;
  isCurrent: boolean;
  isFailed: boolean;
  shouldShowTranslation: boolean;
  showAiOptimize: boolean;
  showSplit: boolean;
  labels: RowLabels;
  onRowClick: (index: number) => void;
  onFieldChange: (
    index: number,
    field: 'sourceContent' | 'targetContent',
    value: string,
  ) => void;
  onSelectionEvent: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onSourceKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    index: number,
  ) => void;
  onTargetKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    index: number,
  ) => void;
  onAiOptimize: (index: number) => void;
  onSplit: (index: number) => void;
}

// 行组件：紧凑单行（默认） / 展开编辑（当前行）
const SubtitleRow = memo(function SubtitleRow({
  subtitle,
  index,
  isCurrent,
  isFailed,
  shouldShowTranslation,
  showAiOptimize,
  showSplit,
  labels,
  onRowClick,
  onFieldChange,
  onSelectionEvent,
  onSourceKeyDown,
  onTargetKeyDown,
  onAiOptimize,
  onSplit,
}: SubtitleRowProps) {
  // 失败行降噪：左缘红条 + ⚠，不再整行红底
  const failedEdge = isFailed
    ? 'border-l-2 border-l-red-500'
    : 'border-l-2 border-l-transparent';

  if (!isCurrent) {
    const src = toPreview(subtitle.sourceContent);
    const tgt = shouldShowTranslation ? toPreview(subtitle.targetContent) : '';
    return (
      <div
        id={`subtitle-${index}`}
        className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs cursor-pointer bg-card hover:bg-accent/50 transition-colors ${failedEdge}`}
        onClick={() => onRowClick(index)}
      >
        {isFailed && (
          <AlertTriangle className="h-3 w-3 flex-shrink-0 text-red-500" />
        )}
        <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground">
          #{subtitle.id} {compactTime(subtitle.startTimeInSeconds)}→
          {compactTime(subtitle.endTimeInSeconds)}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground/90">
          {src}
          {tgt && <span className="text-muted-foreground"> / {tgt}</span>}
        </span>
        {isFailed && (
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-500" />
        )}
      </div>
    );
  }

  return (
    <div
      id={`subtitle-${index}`}
      className={`rounded-md bg-accent p-1.5 text-xs ${failedEdge}`}
    >
      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1">
          {isFailed && <AlertTriangle className="h-3 w-3 text-red-500" />}
          <span>
            #{subtitle.id} · {subtitle.startEndTime} {labels.currentPlaying}
            {isFailed && ` ${labels.translationFailedLabel}`}
          </span>
        </div>
        <TooltipProvider delayDuration={200}>
          <div className="flex items-center gap-0.5">
            {shouldShowTranslation && showAiOptimize && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAiOptimize(index);
                    }}
                  >
                    <Sparkles className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{labels.aiOptimize}</TooltipContent>
              </Tooltip>
            )}
            {showSplit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSplit(index);
                    }}
                  >
                    <Scissors className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{labels.split}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </div>

      <Textarea
        id={`subtitle-src-${index}`}
        className="mb-2 min-h-[24px] resize-none p-1 text-xs"
        value={subtitle.sourceContent}
        onChange={(e) => onFieldChange(index, 'sourceContent', e.target.value)}
        onClick={onSelectionEvent}
        onKeyUp={onSelectionEvent}
        onKeyDown={(e) => onSourceKeyDown(e, index)}
        placeholder={labels.originalSubtitle}
      />

      {shouldShowTranslation && (
        <Textarea
          id={`subtitle-tgt-${index}`}
          className={`resize-none p-1 text-xs ${
            subtitle.targetContent ? 'min-h-[24px]' : 'min-h-[20px]'
          } ${
            isFailed
              ? 'border-red-300 focus:border-red-500 dark:border-red-800 dark:focus:border-red-400'
              : ''
          }`}
          value={subtitle.targetContent || ''}
          onChange={(e) =>
            onFieldChange(index, 'targetContent', e.target.value)
          }
          onKeyDown={(e) => onTargetKeyDown(e, index)}
          placeholder={
            isFailed
              ? labels.translationFailedPlaceholder
              : labels.translatedSubtitle
          }
        />
      )}
    </div>
  );
});

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
  onCursorPositionChange,
  onAiOptimizeClick,
  onSplitClick,
}) => {
  const { t } = useTranslation('home');

  // 获取翻译失败的字幕索引
  const failedIndices = getFailedTranslationIndices();
  const hasFailedTranslations = failedIndices.length > 0;

  // 滚动容器引用
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 用户主动点击字幕时跳过一次自动滚动：被点击的字幕已经在视野内，
  // 再触发自动滚动会导致列表跳动
  const skipNextAutoScrollRef = useRef(false);

  // 最新回调引用：行回调经此分发，保持行 props 恒定让 memo 生效
  const latestRef = useRef({
    handleSubtitleClick,
    handleSubtitleChange,
    onCursorPositionChange,
    onAiOptimizeClick,
    onSplitClick,
    currentSubtitleIndex,
  });
  latestRef.current = {
    handleSubtitleClick,
    handleSubtitleChange,
    onCursorPositionChange,
    onAiOptimizeClick,
    onSplitClick,
    currentSubtitleIndex,
  };

  const virtualizer = useVirtualizer({
    count: mergedSubtitles.length,
    getScrollElement: () => scrollContainerRef.current,
    // 紧凑行 ~30px；展开行由 measureElement 动态测量
    estimateSize: () => 34,
    overscan: 10,
  });

  // 行点击：选中 + 展开 + 视频跳转（沿用现有联动）
  const onRowClick = useCallback((index: number) => {
    if (index !== latestRef.current.currentSubtitleIndex) {
      skipNextAutoScrollRef.current = true;
    }
    latestRef.current.handleSubtitleClick(index);
  }, []);

  const onFieldChange = useCallback(
    (
      index: number,
      field: 'sourceContent' | 'targetContent',
      value: string,
    ) => {
      latestRef.current.handleSubtitleChange(index, field, value);
    },
    [],
  );

  // 光标位置变化（用于拆分功能）
  const onSelectionEvent = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const target = e.target as HTMLTextAreaElement;
      latestRef.current.onCursorPositionChange?.(target.selectionStart || 0);
    },
    [],
  );

  // Tab/Shift+Tab：同一行内原文⇄译文切换焦点（阻断浏览器默认的顺序跳转）
  const focusRowField = (index: number, field: 'src' | 'tgt') => {
    const el = document.getElementById(
      `subtitle-${field}-${index}`,
    ) as HTMLTextAreaElement | null;
    if (el) {
      el.focus();
      el.select?.();
    }
  };

  const onSourceKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, index: number) => {
      if (e.key === 'Tab' && !e.shiftKey && shouldShowTranslation) {
        e.preventDefault();
        focusRowField(index, 'tgt');
      }
    },
    [shouldShowTranslation],
  );

  const onTargetKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, index: number) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        focusRowField(index, 'src');
      }
    },
    [],
  );

  const onAiOptimize = useCallback((index: number) => {
    latestRef.current.onAiOptimizeClick?.(index);
  }, []);

  const onSplit = useCallback((index: number) => {
    latestRef.current.onSplitClick?.(index);
  }, []);

  // 行内文案（memo 化保持引用稳定）
  const labels = useMemo<RowLabels>(
    () => ({
      currentPlaying: t('currentPlaying'),
      translationFailedLabel: t('translationFailedLabel'),
      originalSubtitle: t('originalSubtitle'),
      translatedSubtitle: t('translatedSubtitle'),
      translationFailedPlaceholder: t('translationFailedPlaceholder'),
      aiOptimize: t('aiOptimize') || 'AI 优化',
      split: t('split') || '拆分',
    }),
    [t],
  );

  // 自动滚动到当前字幕（播放跟随 / 失败翻译跳转 / 上下条导航时生效）
  // 用户主动点击的字幕不滚动；等一帧让展开行完成测量后再定位
  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    if (currentSubtitleIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(currentSubtitleIndex, { align: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentSubtitleIndex, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

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

      {/* 字幕列表（虚拟化） */}
      <div className="flex-1 overflow-y-auto" ref={scrollContainerRef}>
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualItem) => {
            const index = virtualItem.index;
            const subtitle = mergedSubtitles[index];
            if (!subtitle) return null;
            return (
              <div
                key={virtualItem.key}
                data-index={index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full px-1 pb-1"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                <SubtitleRow
                  subtitle={subtitle}
                  index={index}
                  isCurrent={index === currentSubtitleIndex}
                  isFailed={isTranslationFailed(subtitle)}
                  shouldShowTranslation={shouldShowTranslation}
                  showAiOptimize={!!onAiOptimizeClick}
                  showSplit={!!onSplitClick}
                  labels={labels}
                  onRowClick={onRowClick}
                  onFieldChange={onFieldChange}
                  onSelectionEvent={onSelectionEvent}
                  onSourceKeyDown={onSourceKeyDown}
                  onTargetKeyDown={onTargetKeyDown}
                  onAiOptimize={onAiOptimize}
                  onSplit={onSplit}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default SubtitleList;
