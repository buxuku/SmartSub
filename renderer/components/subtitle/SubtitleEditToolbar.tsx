import React, { useState, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Search,
  Replace,
  Clock,
  Undo2,
  Redo2,
  Combine,
  Split,
  Scissors,
} from 'lucide-react';
import { toast } from 'sonner';
import { Subtitle } from '../../hooks/useSubtitles';

interface SubtitleEditToolbarProps {
  subtitles: Subtitle[];
  onSubtitlesChange: (subtitles: Subtitle[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  currentSubtitleIndex: number;
  onMergeSubtitles: (startIndex: number, endIndex: number) => void;
  onSplitSubtitle: (
    index: number,
    splitPoint: number,
    splitTime?: number,
  ) => void;
  shouldShowTranslation: boolean;
  getCursorPosition?: () => number; // 获取当前光标位置
}

export default function SubtitleEditToolbar({
  subtitles,
  onSubtitlesChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  currentSubtitleIndex,
  onMergeSubtitles,
  onSplitSubtitle,
  shouldShowTranslation,
  getCursorPosition,
}: SubtitleEditToolbarProps) {
  const { t } = useTranslation('home');

  // 搜索替换状态
  const [showSearchReplace, setShowSearchReplace] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [searchTarget, setSearchTarget] = useState<
    'source' | 'target' | 'both'
  >('both');
  const [matchCount, setMatchCount] = useState(0);

  // 拆分对话框状态
  const [showSplit, setShowSplit] = useState(false);
  const [splitPosition, setSplitPosition] = useState(0);
  const [splitTimePercent, setSplitTimePercent] = useState(50); // 时间拆分百分比

  // 时间轴偏移状态
  const [showTimeOffset, setShowTimeOffset] = useState(false);
  const [timeOffset, setTimeOffset] = useState('0');
  const [offsetDirection, setOffsetDirection] = useState<
    'forward' | 'backward'
  >('forward');

  // 合并状态
  const [showMerge, setShowMerge] = useState(false);
  const [mergeStart, setMergeStart] = useState(currentSubtitleIndex);
  const [mergeEnd, setMergeEnd] = useState(currentSubtitleIndex + 1);

  // 搜索匹配数量
  const handleSearch = useCallback(() => {
    if (!searchText) {
      setMatchCount(0);
      return;
    }

    let count = 0;
    subtitles.forEach((sub) => {
      if (searchTarget === 'source' || searchTarget === 'both') {
        if (sub.sourceContent?.includes(searchText)) count++;
      }
      if (
        (searchTarget === 'target' || searchTarget === 'both') &&
        shouldShowTranslation
      ) {
        if (sub.targetContent?.includes(searchText)) count++;
      }
    });
    setMatchCount(count);
  }, [searchText, searchTarget, subtitles, shouldShowTranslation]);

  // 执行替换
  const handleReplace = useCallback(() => {
    if (!searchText) return;

    const newSubtitles = subtitles.map((sub) => {
      const newSub = { ...sub };
      if (searchTarget === 'source' || searchTarget === 'both') {
        if (newSub.sourceContent) {
          newSub.sourceContent = newSub.sourceContent
            .split(searchText)
            .join(replaceText);
        }
      }
      if (
        (searchTarget === 'target' || searchTarget === 'both') &&
        shouldShowTranslation
      ) {
        if (newSub.targetContent) {
          newSub.targetContent = newSub.targetContent
            .split(searchText)
            .join(replaceText);
        }
      }
      return newSub;
    });

    onSubtitlesChange(newSubtitles);
    toast.success(
      t('replaceSuccess', { count: matchCount }) || `已替换 ${matchCount} 处`,
    );
    setShowSearchReplace(false);
    setSearchText('');
    setReplaceText('');
    setMatchCount(0);
  }, [
    searchText,
    replaceText,
    searchTarget,
    subtitles,
    matchCount,
    onSubtitlesChange,
    shouldShowTranslation,
    t,
  ]);

  // 时间戳字符串转秒数
  const timeToSeconds = (timeStr: string): number => {
    const parts = timeStr.replace(',', '.').split(':');
    if (parts.length !== 3) return 0;
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  };

  // 秒数转时间戳字符串
  const secondsToTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = (seconds % 60).toFixed(3);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.padStart(6, '0').replace('.', ',')}`;
  };

  // 执行时间偏移
  const handleTimeOffset = useCallback(() => {
    const offsetSeconds =
      parseFloat(timeOffset) * (offsetDirection === 'forward' ? 1 : -1);
    if (isNaN(offsetSeconds) || offsetSeconds === 0) return;

    const newSubtitles = subtitles.map((sub) => {
      const newSub = { ...sub };

      // 解析时间范围
      const times = sub.startEndTime.split(' --> ');
      if (times.length === 2) {
        const startSeconds = Math.max(
          0,
          timeToSeconds(times[0]) + offsetSeconds,
        );
        const endSeconds = Math.max(0, timeToSeconds(times[1]) + offsetSeconds);

        newSub.startEndTime = `${secondsToTime(startSeconds)} --> ${secondsToTime(endSeconds)}`;
        newSub.startTimeInSeconds = startSeconds;
        newSub.endTimeInSeconds = endSeconds;
      }

      return newSub;
    });

    onSubtitlesChange(newSubtitles);
    toast.success(t('timeOffsetSuccess') || '时间轴调整完成');
    setShowTimeOffset(false);
  }, [timeOffset, offsetDirection, subtitles, onSubtitlesChange, t]);

  // 执行合并
  const handleMerge = useCallback(() => {
    if (
      mergeStart >= mergeEnd ||
      mergeStart < 0 ||
      mergeEnd > subtitles.length
    ) {
      toast.error(t('invalidMergeRange') || '无效的合并范围');
      return;
    }
    onMergeSubtitles(mergeStart, mergeEnd);
    setShowMerge(false);
  }, [mergeStart, mergeEnd, subtitles.length, onMergeSubtitles, t]);

  return (
    <div className="flex items-center gap-1 p-2 border-b bg-muted/30">
      {/* 撤销/重做 */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={onUndo}
        disabled={!canUndo}
        title={t('undo') || '撤销'}
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={onRedo}
        disabled={!canRedo}
        title={t('redo') || '重做'}
      >
        <Redo2 className="h-4 w-4" />
      </Button>

      <div className="w-px h-6 bg-border mx-1" />

      {/* 搜索替换 */}
      <Popover open={showSearchReplace} onOpenChange={setShowSearchReplace}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            title={t('searchReplace') || '搜索替换'}
          >
            <Search className="h-4 w-4 mr-1" />
            {t('searchReplace') || '搜索替换'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>{t('searchText') || '搜索内容'}</Label>
              <Input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={t('enterSearchText') || '输入搜索内容'}
                onKeyUp={handleSearch}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('replaceWith') || '替换为'}</Label>
              <Input
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder={t('enterReplaceText') || '输入替换内容'}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('searchIn') || '搜索范围'}</Label>
              <Select
                value={searchTarget}
                onValueChange={(v: any) => setSearchTarget(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="source">
                    {t('sourceOnly') || '仅原文'}
                  </SelectItem>
                  {shouldShowTranslation && (
                    <SelectItem value="target">
                      {t('targetOnly') || '仅翻译'}
                    </SelectItem>
                  )}
                  {shouldShowTranslation && (
                    <SelectItem value="both">
                      {t('sourceAndTarget') || '原文和翻译'}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            {matchCount > 0 && (
              <p className="text-sm text-muted-foreground">
                {t('matchFound', { count: matchCount }) ||
                  `找到 ${matchCount} 处匹配`}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={handleSearch}>
                <Search className="h-4 w-4 mr-1" />
                {t('search') || '搜索'}
              </Button>
              <Button
                size="sm"
                onClick={handleReplace}
                disabled={matchCount === 0}
              >
                <Replace className="h-4 w-4 mr-1" />
                {t('replaceAll') || '全部替换'}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* 时间轴微调 */}
      <Popover open={showTimeOffset} onOpenChange={setShowTimeOffset}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            title={t('timeOffset') || '时间轴微调'}
          >
            <Clock className="h-4 w-4 mr-1" />
            {t('timeOffset') || '时间轴'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>{t('offsetSeconds') || '偏移秒数'}</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  step="0.1"
                  value={timeOffset}
                  onChange={(e) => setTimeOffset(e.target.value)}
                  placeholder="0.5"
                />
                <Select
                  value={offsetDirection}
                  onValueChange={(v: any) => setOffsetDirection(v)}
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="forward">
                      {t('forward') || '延后'}
                    </SelectItem>
                    <SelectItem value="backward">
                      {t('backward') || '提前'}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button size="sm" onClick={handleTimeOffset} className="w-full">
              {t('applyOffset') || '应用偏移'}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* 合并字幕 */}
      <Dialog open={showMerge} onOpenChange={setShowMerge}>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => {
            setMergeStart(currentSubtitleIndex);
            setMergeEnd(Math.min(currentSubtitleIndex + 2, subtitles.length));
            setShowMerge(true);
          }}
          title={t('mergeSubtitles') || '合并字幕'}
        >
          <Combine className="h-4 w-4 mr-1" />
          {t('merge') || '合并'}
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('mergeSubtitles') || '合并字幕'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('startIndex') || '起始序号'}</Label>
                <Input
                  type="number"
                  min={0}
                  max={subtitles.length - 1}
                  value={mergeStart + 1}
                  onChange={(e) =>
                    setMergeStart(Math.max(0, parseInt(e.target.value) - 1))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>{t('endIndex') || '结束序号'}</Label>
                <Input
                  type="number"
                  min={1}
                  max={subtitles.length}
                  value={mergeEnd}
                  onChange={(e) =>
                    setMergeEnd(
                      Math.min(subtitles.length, parseInt(e.target.value)),
                    )
                  }
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('mergeHint') ||
                '将合并第 {{start}} 到第 {{end}} 条字幕'
                  .replace('{{start}}', String(mergeStart + 1))
                  .replace('{{end}}', String(mergeEnd))}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMerge(false)}>
              {t('cancel') || '取消'}
            </Button>
            <Button onClick={handleMerge}>
              {t('confirmMerge') || '确认合并'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 拆分字幕 */}
      <Dialog open={showSplit} onOpenChange={setShowSplit}>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => {
            if (
              currentSubtitleIndex >= 0 &&
              currentSubtitleIndex < subtitles.length
            ) {
              const subtitle = subtitles[currentSubtitleIndex];
              const content = subtitle.sourceContent || '';
              const cursorPos = getCursorPosition
                ? getCursorPosition()
                : Math.floor(content.length / 2);
              setSplitPosition(
                Math.max(1, Math.min(cursorPos, content.length - 1)),
              );
              setSplitTimePercent(50);
              setShowSplit(true);
            }
          }}
          disabled={currentSubtitleIndex < 0}
          title={t('splitSubtitle') || '拆分字幕'}
        >
          <Scissors className="h-4 w-4 mr-1" />
          {t('split') || '拆分'}
        </Button>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('splitSubtitle') || '拆分字幕'}</DialogTitle>
            <DialogDescription>
              {t('splitSubtitleDesc') || '选择文字拆分位置和时间分配'}
            </DialogDescription>
          </DialogHeader>
          {currentSubtitleIndex >= 0 &&
            currentSubtitleIndex < subtitles.length && (
              <SplitPreview
                subtitle={subtitles[currentSubtitleIndex]}
                splitPosition={splitPosition}
                setSplitPosition={setSplitPosition}
                splitTimePercent={splitTimePercent}
                setSplitTimePercent={setSplitTimePercent}
                shouldShowTranslation={shouldShowTranslation}
                t={t}
              />
            )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSplit(false)}>
              {t('cancel') || '取消'}
            </Button>
            <Button
              onClick={() => {
                if (currentSubtitleIndex >= 0) {
                  const subtitle = subtitles[currentSubtitleIndex];
                  const startTime = subtitle.startTimeInSeconds || 0;
                  const endTime = subtitle.endTimeInSeconds || 0;
                  const splitTime =
                    startTime +
                    (endTime - startTime) * (splitTimePercent / 100);
                  onSplitSubtitle(
                    currentSubtitleIndex,
                    splitPosition,
                    splitTime,
                  );
                  setShowSplit(false);
                }
              }}
            >
              {t('confirmSplit') || '确认拆分'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// 拆分预览组件
interface SplitPreviewProps {
  subtitle: Subtitle;
  splitPosition: number;
  setSplitPosition: (pos: number) => void;
  splitTimePercent: number;
  setSplitTimePercent: (percent: number) => void;
  shouldShowTranslation: boolean;
  t: (key: string) => string;
}

function SplitPreview({
  subtitle,
  splitPosition,
  setSplitPosition,
  splitTimePercent,
  setSplitTimePercent,
  shouldShowTranslation,
  t,
}: SplitPreviewProps) {
  const content = subtitle.sourceContent || '';
  const targetContent = subtitle.targetContent || '';
  const startTime = subtitle.startTimeInSeconds || 0;
  const endTime = subtitle.endTimeInSeconds || 0;
  const duration = endTime - startTime;

  // 计算拆分后的内容
  const part1 = content.slice(0, splitPosition);
  const part2 = content.slice(splitPosition);

  // 按比例计算翻译拆分点
  const targetSplitPos = Math.floor(
    targetContent.length * (splitPosition / Math.max(content.length, 1)),
  );
  const targetPart1 = targetContent.slice(0, targetSplitPos);
  const targetPart2 = targetContent.slice(targetSplitPos);

  // 计算时间
  const splitTime = startTime + duration * (splitTimePercent / 100);

  // 格式化时间显示
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(2);
    return `${m}:${s.padStart(5, '0')}`;
  };

  return (
    <div className="space-y-4 py-4">
      {/* 文字拆分位置 */}
      <div className="space-y-2">
        <Label>{t('textSplitPosition') || '文字拆分位置'}</Label>
        <div className="flex items-center gap-2">
          <Slider
            value={[splitPosition]}
            min={1}
            max={Math.max(content.length - 1, 1)}
            step={1}
            onValueChange={([v]) => setSplitPosition(v)}
            className="flex-1"
          />
          <span className="text-sm text-muted-foreground w-16 text-right">
            {splitPosition}/{content.length}
          </span>
        </div>
      </div>

      {/* 原文预览 */}
      <div className="space-y-2">
        <Label>{t('sourcePreview') || '原文预览'}</Label>
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2 border rounded text-sm bg-muted/30 min-h-[60px]">
            <div className="text-xs text-muted-foreground mb-1">
              {t('part1') || '第一部分'}
            </div>
            {part1 || (
              <span className="text-muted-foreground italic">
                {t('empty') || '(空)'}
              </span>
            )}
          </div>
          <div className="p-2 border rounded text-sm bg-muted/30 min-h-[60px]">
            <div className="text-xs text-muted-foreground mb-1">
              {t('part2') || '第二部分'}
            </div>
            {part2 || (
              <span className="text-muted-foreground italic">
                {t('empty') || '(空)'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 翻译预览 */}
      {shouldShowTranslation && targetContent && (
        <div className="space-y-2">
          <Label>{t('translationPreview') || '翻译预览'}</Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 border rounded text-sm bg-muted/30 min-h-[40px]">
              {targetPart1 || (
                <span className="text-muted-foreground italic">
                  {t('empty') || '(空)'}
                </span>
              )}
            </div>
            <div className="p-2 border rounded text-sm bg-muted/30 min-h-[40px]">
              {targetPart2 || (
                <span className="text-muted-foreground italic">
                  {t('empty') || '(空)'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 时间拆分 */}
      <div className="space-y-2">
        <Label>{t('timeSplitPosition') || '时间拆分点'}</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {formatTime(startTime)}
          </span>
          <Slider
            value={[splitTimePercent]}
            min={5}
            max={95}
            step={1}
            onValueChange={([v]) => setSplitTimePercent(v)}
            className="flex-1"
          />
          <span className="text-sm text-muted-foreground">
            {formatTime(endTime)}
          </span>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {t('part1Duration') || '第一部分'}:{' '}
            {formatTime(splitTime - startTime)}
          </span>
          <span className="font-medium">{formatTime(splitTime)}</span>
          <span>
            {t('part2Duration') || '第二部分'}:{' '}
            {formatTime(endTime - splitTime)}
          </span>
        </div>
      </div>
    </div>
  );
}
