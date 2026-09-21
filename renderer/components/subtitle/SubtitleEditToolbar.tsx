import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronsDownUp,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { Subtitle } from '../../hooks/useSubtitles';

/** 出现次数统计（支持大小写不敏感） */
const countOccurrences = (
  text: string,
  needle: string,
  caseSensitive: boolean,
): number => {
  if (!needle || !text) return 0;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  let pos = haystack.indexOf(n);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(n, pos + n.length);
  }
  return count;
};

/** 全部替换（支持大小写不敏感，保留未匹配部分原样） */
const replaceAllWithCase = (
  text: string,
  needle: string,
  replacement: string,
  caseSensitive: boolean,
): string => {
  if (!needle || !text) return text;
  if (caseSensitive) return text.split(needle).join(replacement);
  const haystack = text.toLowerCase();
  const n = needle.toLowerCase();
  let result = '';
  let last = 0;
  let pos = haystack.indexOf(n);
  while (pos !== -1) {
    result += text.slice(last, pos) + replacement;
    last = pos + n.length;
    pos = haystack.indexOf(n, last);
  }
  return result + text.slice(last);
};

/** 匹配位置：第 index 条的某个字段（替换粒度为条+字段） */
interface SearchMatch {
  index: number;
  field: 'sourceContent' | 'targetContent';
}

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
  // 外部触发器
  triggerSplit?: boolean;
  onTriggerHandled?: () => void; // 当触发器被处理后调用
  /** 外部请求打开搜索替换（Cmd/Ctrl+F）：token 递增时展开面板并聚焦搜索框 */
  searchOpenToken?: number;
  /** 定位到某条字幕（展开行并滚动到可视区），用于搜索逐条跳转 */
  onLocateSubtitle?: (index: number) => void;
  /** 视图控制（从字幕列表上提，统一放右侧） */
  hasVideo?: boolean;
  videoCollapsed?: boolean;
  onToggleVideoCollapsed?: () => void;
  expandAll?: boolean;
  onToggleExpandAll?: () => void;
  fontScale?: 's' | 'm' | 'l';
  onFontScale?: (scale: 's' | 'm' | 'l') => void;
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
  triggerSplit,
  onTriggerHandled,
  searchOpenToken,
  onLocateSubtitle,
  hasVideo,
  videoCollapsed,
  onToggleVideoCollapsed,
  expandAll,
  onToggleExpandAll,
  fontScale,
  onFontScale,
}: SubtitleEditToolbarProps) {
  const { t } = useTranslation('home');

  // 搜索替换状态
  const [showSearchReplace, setShowSearchReplace] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [searchTarget, setSearchTarget] = useState<
    'source' | 'target' | 'both'
  >('both');
  const [caseSensitive, setCaseSensitive] = useState(false);
  // 匹配列表（条+字段粒度）与当前导航位置（-1 表示尚未导航）
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [totalOccurrences, setTotalOccurrences] = useState(0);
  const [matchPointer, setMatchPointer] = useState(-1);
  const matchCount = searchMatches.length;

  // Cmd/Ctrl+F 外部触发：展开搜索面板并聚焦搜索框（等 Popover 挂载后聚焦）
  useEffect(() => {
    if (!searchOpenToken) return;
    setShowSearchReplace(true);
    const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [searchOpenToken]);

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

  // 构建匹配列表：返回（条+字段）列表与总出现次数
  const buildMatches = useCallback(
    (subs: Subtitle[]): { matches: SearchMatch[]; total: number } => {
      const matches: SearchMatch[] = [];
      let total = 0;
      if (!searchText) return { matches, total };
      subs.forEach((sub, index) => {
        if (searchTarget === 'source' || searchTarget === 'both') {
          const c = countOccurrences(
            sub.sourceContent || '',
            searchText,
            caseSensitive,
          );
          if (c > 0) {
            matches.push({ index, field: 'sourceContent' });
            total += c;
          }
        }
        if (
          (searchTarget === 'target' || searchTarget === 'both') &&
          shouldShowTranslation
        ) {
          const c = countOccurrences(
            sub.targetContent || '',
            searchText,
            caseSensitive,
          );
          if (c > 0) {
            matches.push({ index, field: 'targetContent' });
            total += c;
          }
        }
      });
      return { matches, total };
    },
    [searchText, searchTarget, caseSensitive, shouldShowTranslation],
  );

  // 搜索：重建匹配列表，导航位置复位
  const handleSearch = useCallback(() => {
    const { matches, total } = buildMatches(subtitles);
    setSearchMatches(matches);
    setTotalOccurrences(total);
    setMatchPointer(-1);
  }, [buildMatches, subtitles]);

  // 逐处导航：循环跳转并定位该条字幕
  const handleNavigateMatch = useCallback(
    (dir: 1 | -1) => {
      if (!searchMatches.length) return;
      const len = searchMatches.length;
      const next =
        matchPointer < 0
          ? dir === 1
            ? 0
            : len - 1
          : (matchPointer + dir + len) % len;
      setMatchPointer(next);
      onLocateSubtitle?.(searchMatches[next].index);
    },
    [searchMatches, matchPointer, onLocateSubtitle],
  );

  // 替换当前定位的一条（该条该字段内全部出现）
  const handleReplaceCurrent = useCallback(() => {
    if (matchPointer < 0 || matchPointer >= searchMatches.length) return;
    const m = searchMatches[matchPointer];
    const target = subtitles[m.index]?.[m.field] || '';
    // 文本已被手动改动导致不再匹配：重算列表，不做替换
    if (countOccurrences(target, searchText, caseSensitive) === 0) {
      handleSearch();
      return;
    }
    const newSubtitles = subtitles.map((sub, i) =>
      i === m.index
        ? {
            ...sub,
            [m.field]: replaceAllWithCase(
              target,
              searchText,
              replaceText,
              caseSensitive,
            ),
          }
        : sub,
    );
    onSubtitlesChange(newSubtitles);
    // 基于替换后的内容重建列表，停留在原位置的下一处
    const { matches, total } = buildMatches(newSubtitles);
    setSearchMatches(matches);
    setTotalOccurrences(total);
    if (!matches.length) {
      setMatchPointer(-1);
      toast.success(t('replaceAllDone'));
      return;
    }
    const next = Math.min(matchPointer, matches.length - 1);
    setMatchPointer(next);
    onLocateSubtitle?.(matches[next].index);
  }, [
    matchPointer,
    searchMatches,
    subtitles,
    searchText,
    replaceText,
    caseSensitive,
    buildMatches,
    onSubtitlesChange,
    onLocateSubtitle,
    handleSearch,
    t,
  ]);

  // 全部替换
  const handleReplace = useCallback(() => {
    if (!searchText) return;

    const newSubtitles = subtitles.map((sub) => {
      const newSub = { ...sub };
      if (searchTarget === 'source' || searchTarget === 'both') {
        if (newSub.sourceContent) {
          newSub.sourceContent = replaceAllWithCase(
            newSub.sourceContent,
            searchText,
            replaceText,
            caseSensitive,
          );
        }
      }
      if (
        (searchTarget === 'target' || searchTarget === 'both') &&
        shouldShowTranslation
      ) {
        if (newSub.targetContent) {
          newSub.targetContent = replaceAllWithCase(
            newSub.targetContent,
            searchText,
            replaceText,
            caseSensitive,
          );
        }
      }
      return newSub;
    });

    onSubtitlesChange(newSubtitles);
    toast.success(
      t('replaceSuccess', { count: totalOccurrences }) ||
        `已替换 ${totalOccurrences} 处`,
    );
    setShowSearchReplace(false);
    setSearchText('');
    setReplaceText('');
    setSearchMatches([]);
    setTotalOccurrences(0);
    setMatchPointer(-1);
  }, [
    searchText,
    replaceText,
    searchTarget,
    caseSensitive,
    subtitles,
    totalOccurrences,
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
    toast.success(t('timeOffsetSuccess'));
    setShowTimeOffset(false);
  }, [timeOffset, offsetDirection, subtitles, onSubtitlesChange, t]);

  // 执行合并
  const handleMerge = useCallback(() => {
    if (
      mergeStart >= mergeEnd ||
      mergeStart < 0 ||
      mergeEnd > subtitles.length
    ) {
      toast.error(t('invalidMergeRange'));
      return;
    }
    onMergeSubtitles(mergeStart, mergeEnd);
    setShowMerge(false);
  }, [mergeStart, mergeEnd, subtitles.length, onMergeSubtitles, t]);

  // 打开拆分对话框
  const handleOpenSplit = useCallback(() => {
    if (currentSubtitleIndex >= 0 && currentSubtitleIndex < subtitles.length) {
      const subtitle = subtitles[currentSubtitleIndex];
      const content = subtitle.sourceContent || '';
      const cursorPos = getCursorPosition
        ? getCursorPosition()
        : Math.floor(content.length / 2);
      setSplitPosition(Math.max(1, Math.min(cursorPos, content.length - 1)));
      setSplitTimePercent(50);
      setShowSplit(true);
    }
  }, [currentSubtitleIndex, subtitles, getCursorPosition]);

  useEffect(() => {
    if (triggerSplit && currentSubtitleIndex >= 0) {
      handleOpenSplit();
      onTriggerHandled?.();
    }
  }, [triggerSplit, currentSubtitleIndex, handleOpenSplit, onTriggerHandled]);

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 p-2 border-b bg-muted/30">
      {/* 撤销/重做 */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={onUndo}
        disabled={!canUndo}
        title={t('undo')}
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={onRedo}
        disabled={!canRedo}
        title={t('redo')}
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
            title={t('searchReplace')}
          >
            <Search className="h-4 w-4 mr-1" />
            {t('searchReplace')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>{t('searchText')}</Label>
              <Input
                ref={searchInputRef}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={t('enterSearchText')}
                onKeyUp={handleSearch}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('replaceWith')}</Label>
              <Input
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder={t('enterReplaceText')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('searchIn')}</Label>
              <Select
                value={searchTarget}
                onValueChange={(v: any) => setSearchTarget(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="source">{t('sourceOnly')}</SelectItem>
                  {shouldShowTranslation && (
                    <SelectItem value="target">{t('targetOnly')}</SelectItem>
                  )}
                  {shouldShowTranslation && (
                    <SelectItem value="both">{t('sourceAndTarget')}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <Checkbox
                checked={caseSensitive}
                onCheckedChange={(v) => setCaseSensitive(v === true)}
              />
              {t('caseSensitive')}
            </label>
            {matchCount > 0 && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground tabular-nums">
                  {matchPointer >= 0
                    ? `${matchPointer + 1}/${matchCount}`
                    : t('matchSummary', {
                        entries: matchCount,
                        total: totalOccurrences,
                      })}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    title={t('prevMatch')}
                    onClick={() => handleNavigateMatch(-1)}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    title={t('nextMatch')}
                    onClick={() => handleNavigateMatch(1)}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs"
                    disabled={matchPointer < 0}
                    onClick={handleReplaceCurrent}
                  >
                    <Replace className="h-4 w-4" />
                    {t('replaceCurrent')}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={handleSearch}>
                <Search className="h-4 w-4 mr-1" />
                {t('search')}
              </Button>
              <Button
                size="sm"
                onClick={handleReplace}
                disabled={matchCount === 0}
              >
                <Replace className="h-4 w-4 mr-1" />
                {t('replaceAll')}
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
            title={t('timeOffset')}
          >
            <Clock className="h-4 w-4 mr-1" />
            {t('timeOffset')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>{t('offsetSeconds')}</Label>
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
                    <SelectItem value="forward">{t('forward')}</SelectItem>
                    <SelectItem value="backward">{t('backward')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              size="sm"
              onClick={handleTimeOffset}
              className="w-full gap-1.5"
            >
              <Clock className="h-4 w-4" />
              {t('applyOffset')}
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
          title={t('mergeSubtitles')}
        >
          <Combine className="h-4 w-4 mr-1" />
          {t('merge')}
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('mergeSubtitles')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('startIndex')}</Label>
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
                <Label>{t('endIndex')}</Label>
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
              {t('mergeHint')
                .replace('{{start}}', String(mergeStart + 1))
                .replace('{{end}}', String(mergeEnd))}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => setShowMerge(false)}
            >
              <X className="h-4 w-4" />
              {t('cancel')}
            </Button>
            <Button className="gap-1.5" onClick={handleMerge}>
              <Combine className="h-4 w-4" />
              {t('confirmMerge')}
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
          onClick={handleOpenSplit}
          disabled={currentSubtitleIndex < 0}
          title={t('splitSubtitle')}
        >
          <Scissors className="h-4 w-4 mr-1" />
          {t('split')}
        </Button>
        <DialogContent className="max-w-lg flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('splitSubtitle')}</DialogTitle>
            <DialogDescription>{t('splitSubtitleDesc')}</DialogDescription>
          </DialogHeader>
          {/* 长字幕时预览区可滚动，确保底部的确认按钮始终可见 */}
          <div className="flex-1 min-h-0 overflow-y-auto">
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
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => setShowSplit(false)}
            >
              <X className="h-4 w-4" />
              {t('cancel')}
            </Button>
            <Button
              className="gap-1.5"
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
              <Scissors className="h-4 w-4" />
              {t('confirmSplit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 视图控制（右对齐）：折叠左侧面板 / 展开全部 / 字号 */}
      <div className="ml-auto flex flex-shrink-0 items-center gap-1">
        {hasVideo && onToggleVideoCollapsed && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={onToggleVideoCollapsed}
            title={videoCollapsed ? t('showPanel') : t('hidePanel')}
          >
            {videoCollapsed ? (
              <PanelLeftOpen className="h-4 w-4 mr-1" />
            ) : (
              <PanelLeftClose className="h-4 w-4 mr-1" />
            )}
            {videoCollapsed ? t('showPanel') : t('hidePanel')}
          </Button>
        )}
        {onToggleExpandAll && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={onToggleExpandAll}
            title={expandAll ? t('collapseAll') : t('expandAll')}
          >
            {expandAll ? (
              <ChevronsDownUp className="h-4 w-4 mr-1" />
            ) : (
              <ChevronsUpDown className="h-4 w-4 mr-1" />
            )}
            {expandAll ? t('collapseAll') : t('expandAll')}
          </Button>
        )}
        {onFontScale && (
          <div className="flex items-center overflow-hidden rounded-md border">
            {(['s', 'm', 'l'] as const).map((scale) => (
              <button
                key={scale}
                type="button"
                onClick={() => onFontScale(scale)}
                className={`px-2 py-1 text-xs transition-colors ${
                  fontScale === scale
                    ? 'bg-primary/5 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                {scale === 's'
                  ? t('fontSizeSmall')
                  : scale === 'm'
                    ? t('fontSizeMedium')
                    : t('fontSizeLarge')}
              </button>
            ))}
          </div>
        )}
      </div>
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
        <Label>{t('textSplitPosition')}</Label>
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
        <Label>{t('sourcePreview')}</Label>
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2 border rounded text-sm bg-muted/30 min-h-[60px]">
            <div className="text-xs text-muted-foreground mb-1">
              {t('part1')}
            </div>
            {part1 || (
              <span className="text-muted-foreground italic">{t('empty')}</span>
            )}
          </div>
          <div className="p-2 border rounded text-sm bg-muted/30 min-h-[60px]">
            <div className="text-xs text-muted-foreground mb-1">
              {t('part2')}
            </div>
            {part2 || (
              <span className="text-muted-foreground italic">{t('empty')}</span>
            )}
          </div>
        </div>
      </div>

      {/* 翻译预览 */}
      {shouldShowTranslation && targetContent && (
        <div className="space-y-2">
          <Label>{t('translationPreview')}</Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 border rounded text-sm bg-muted/30 min-h-[40px]">
              {targetPart1 || (
                <span className="text-muted-foreground italic">
                  {t('empty')}
                </span>
              )}
            </div>
            <div className="p-2 border rounded text-sm bg-muted/30 min-h-[40px]">
              {targetPart2 || (
                <span className="text-muted-foreground italic">
                  {t('empty')}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 时间拆分 */}
      <div className="space-y-2">
        <Label>{t('timeSplitPosition')}</Label>
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
            {t('part1Duration')}: {formatTime(splitTime - startTime)}
          </span>
          <span className="font-medium">{formatTime(splitTime)}</span>
          <span>
            {t('part2Duration')}: {formatTime(endTime - splitTime)}
          </span>
        </div>
      </div>
    </div>
  );
}
