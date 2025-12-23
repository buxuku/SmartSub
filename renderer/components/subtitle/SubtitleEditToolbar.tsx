import React, { useState, useCallback, useEffect } from 'react';
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
  Sparkles,
  Loader2,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Subtitle } from '../../hooks/useSubtitles';
import BatchAiOptimizeDialog from './BatchAiOptimizeDialog';

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
  triggerAiOptimize?: boolean;
  triggerSplit?: boolean;
  onTriggerHandled?: () => void; // 当触发器被处理后调用
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
  triggerAiOptimize,
  triggerSplit,
  onTriggerHandled,
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

  // AI 优化状态
  const [showAiOptimize, setShowAiOptimize] = useState(false);
  const [aiOptimizing, setAiOptimizing] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [aiProviders, setAiProviders] = useState<any[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [showCustomPrompt, setShowCustomPrompt] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');
  const [isCustomPromptLoaded, setIsCustomPromptLoaded] = useState(false);

  // 批量 AI 优化状态
  const [showBatchOptimize, setShowBatchOptimize] = useState(false);

  // 默认优化/翻译提示词模板（支持条件模板）
  const defaultOptimizePrompt = `You are a professional subtitle translator and proofreader.

Original text ({{sourceLanguage}}):
{{sourceText}}

{{#if targetText}}
Current translation ({{targetLanguage}}):
{{targetText}}

Please improve the translation to:
{{else}}
Please translate the original text to {{targetLanguage}}:
{{/if}}
1. Accurately convey the meaning of the original
2. Use natural and fluent {{targetLanguage}} expressions
3. Be appropriate for subtitle display (concise but complete)
4. Maintain the tone and style of the original

Only respond with the translated/improved text, nothing else.`;

  // 提示词缓存 key
  const PROMPT_CACHE_KEY = 'ai_optimize_custom_prompt';

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

  // 加载 AI 服务商列表
  const loadAiProviders = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('getAiTranslationProviders');
      if (result.success && result.data) {
        setAiProviders(result.data);
        // 默认选择第一个服务商
        if (result.data.length > 0 && !selectedProviderId) {
          setSelectedProviderId(result.data[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to load AI providers:', error);
    }
  }, [selectedProviderId]);

  // 加载缓存的自定义提示词
  const loadCachedPrompt = useCallback(() => {
    if (isCustomPromptLoaded) return;

    try {
      const cached = localStorage.getItem(PROMPT_CACHE_KEY);
      if (cached) {
        setCustomPrompt(cached);
        setShowCustomPrompt(true); // 如果有缓存的提示词，自动展开
      } else {
        setCustomPrompt(defaultOptimizePrompt);
      }
      setIsCustomPromptLoaded(true);
    } catch (error) {
      console.error('Failed to load cached prompt:', error);
      setCustomPrompt(defaultOptimizePrompt);
      setIsCustomPromptLoaded(true);
    }
  }, [isCustomPromptLoaded, defaultOptimizePrompt]);

  // 保存自定义提示词到缓存
  const savePromptToCache = useCallback(
    (prompt: string) => {
      try {
        // 只有当提示词与默认不同时才缓存
        if (prompt.trim() !== defaultOptimizePrompt.trim()) {
          localStorage.setItem(PROMPT_CACHE_KEY, prompt);
        } else {
          // 如果恢复为默认，清除缓存
          localStorage.removeItem(PROMPT_CACHE_KEY);
        }
      } catch (error) {
        console.error('Failed to save prompt to cache:', error);
      }
    },
    [defaultOptimizePrompt],
  );

  // 处理提示词变化
  const handlePromptChange = useCallback(
    (value: string) => {
      setCustomPrompt(value);
      savePromptToCache(value);
    },
    [savePromptToCache],
  );

  // 重置为默认提示词
  const handleResetPrompt = useCallback(() => {
    setCustomPrompt(defaultOptimizePrompt);
    localStorage.removeItem(PROMPT_CACHE_KEY);
  }, [defaultOptimizePrompt]);

  // 打开 AI 优化对话框时加载服务商
  const handleOpenAiOptimize = useCallback(() => {
    if (currentSubtitleIndex >= 0) {
      setOptimizedText('');
      loadAiProviders();
      loadCachedPrompt();
      setShowAiOptimize(true);
    }
  }, [currentSubtitleIndex, loadAiProviders, loadCachedPrompt]);

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

  // 处理外部触发
  useEffect(() => {
    if (triggerAiOptimize && currentSubtitleIndex >= 0) {
      handleOpenAiOptimize();
      onTriggerHandled?.();
    }
  }, [
    triggerAiOptimize,
    currentSubtitleIndex,
    handleOpenAiOptimize,
    onTriggerHandled,
  ]);

  useEffect(() => {
    if (triggerSplit && currentSubtitleIndex >= 0) {
      handleOpenSplit();
      onTriggerHandled?.();
    }
  }, [triggerSplit, currentSubtitleIndex, handleOpenSplit, onTriggerHandled]);

  // AI 优化当前字幕
  const handleAiOptimize = useCallback(async () => {
    if (currentSubtitleIndex < 0 || currentSubtitleIndex >= subtitles.length) {
      return;
    }

    const subtitle = subtitles[currentSubtitleIndex];
    const sourceText = subtitle.sourceContent || '';
    const targetText = subtitle.targetContent || '';

    // 如果没有翻译内容，也可以使用 AI 生成翻译

    if (aiProviders.length === 0) {
      toast.error(t('noAiProviderConfigured') || '请先配置 AI 翻译服务');
      return;
    }

    setAiOptimizing(true);
    setOptimizedText('');

    try {
      // 调用 AI 优化服务（始终传递提示词）
      const result = await window.ipc.invoke('optimizeSubtitle', {
        sourceText,
        targetText,
        providerId: selectedProviderId || undefined,
        customPrompt: customPrompt.trim() || undefined,
      });

      if (result.success && result.data) {
        setOptimizedText(result.data);
      } else {
        toast.error(result.error || t('aiOptimizeFailed') || 'AI 优化失败');
      }
    } catch (error) {
      console.error('AI optimize error:', error);
      toast.error(t('aiOptimizeFailed') || 'AI 优化失败');
    } finally {
      setAiOptimizing(false);
    }
  }, [
    currentSubtitleIndex,
    subtitles,
    t,
    aiProviders,
    selectedProviderId,
    customPrompt,
  ]);

  // 采纳 AI 优化结果
  const handleAcceptOptimization = useCallback(() => {
    if (!optimizedText || currentSubtitleIndex < 0) return;

    const newSubtitles = [...subtitles];
    newSubtitles[currentSubtitleIndex] = {
      ...newSubtitles[currentSubtitleIndex],
      targetContent: optimizedText,
    };
    onSubtitlesChange(newSubtitles);
    setShowAiOptimize(false);
    setOptimizedText('');
    toast.success(t('optimizationAccepted') || '已采纳优化结果');
  }, [optimizedText, currentSubtitleIndex, subtitles, onSubtitlesChange, t]);

  // 应用批量优化结果
  const handleApplyBatchOptimizations = useCallback(
    (optimizations: Array<{ index: number; targetContent: string }>) => {
      const newSubtitles = [...subtitles];
      optimizations.forEach(({ index, targetContent }) => {
        if (index >= 0 && index < newSubtitles.length) {
          newSubtitles[index] = {
            ...newSubtitles[index],
            targetContent,
          };
        }
      });
      onSubtitlesChange(newSubtitles);
    },
    [subtitles, onSubtitlesChange],
  );

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
          onClick={handleOpenSplit}
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

      {/* AI 单条优化按钮和对话框 */}
      {shouldShowTranslation && (
        <Dialog open={showAiOptimize} onOpenChange={setShowAiOptimize}>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={handleOpenAiOptimize}
            disabled={currentSubtitleIndex < 0}
            title={t('aiOptimize') || 'AI 优化'}
          >
            <Sparkles className="h-4 w-4 mr-1" />
            {t('aiOptimize') || 'AI 优化'}
          </Button>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t('aiOptimizeTitle') || 'AI 优化翻译'}</DialogTitle>
              <DialogDescription>
                {t('aiOptimizeDesc') || '使用 AI 优化当前字幕的翻译质量'}
              </DialogDescription>
            </DialogHeader>
            {currentSubtitleIndex >= 0 &&
              currentSubtitleIndex < subtitles.length && (
                <div className="space-y-4 py-4">
                  {/* AI 服务商选择 */}
                  <div className="space-y-2">
                    <Label>{t('selectAiProvider') || '选择 AI 服务'}</Label>
                    {aiProviders.length === 0 ? (
                      <div className="p-3 border rounded bg-muted/30 text-sm text-muted-foreground italic">
                        {t('noAiProviderConfigured') ||
                          '未配置 AI 翻译服务，请先在设置中添加'}
                      </div>
                    ) : (
                      <Select
                        value={selectedProviderId}
                        onValueChange={setSelectedProviderId}
                      >
                        <SelectTrigger>
                          <SelectValue
                            placeholder={t('selectProvider') || '选择服务商'}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {aiProviders.map((provider) => (
                            <SelectItem key={provider.id} value={provider.id}>
                              {provider.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  {/* 原文 */}
                  <div className="space-y-2">
                    <Label>{t('sourceText') || '原文'}</Label>
                    <div className="p-3 border rounded bg-muted/30 text-sm">
                      {subtitles[currentSubtitleIndex].sourceContent || (
                        <span className="text-muted-foreground italic">
                          {t('empty') || '(空)'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 当前翻译 */}
                  <div className="space-y-2">
                    <Label>{t('currentTranslation') || '当前翻译'}</Label>
                    <div className="p-3 border rounded bg-muted/30 text-sm">
                      {subtitles[currentSubtitleIndex].targetContent || (
                        <span className="text-muted-foreground italic">
                          {t('empty') || '(空)'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 自定义提示词 */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t('customPrompt') || '优化提示词'}</Label>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleResetPrompt}
                          title={t('resetToDefault') || '重置为默认'}
                        >
                          {t('resetToDefault') || '重置'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowCustomPrompt(!showCustomPrompt)}
                        >
                          {showCustomPrompt
                            ? t('hideCustomPrompt') || '收起'
                            : t('showCustomPrompt') || '展开'}
                        </Button>
                      </div>
                    </div>
                    {showCustomPrompt && (
                      <div className="space-y-2">
                        <Textarea
                          value={customPrompt}
                          onChange={(e) => handlePromptChange(e.target.value)}
                          placeholder={
                            t('customPromptPlaceholder') ||
                            '输入自定义提示词，可使用变量：{{sourceLanguage}}、{{targetLanguage}}、{{sourceText}}、{{targetText}}'
                          }
                          className="min-h-[200px] text-sm font-mono"
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('customPromptHint') ||
                            '支持的变量：{{sourceLanguage}} - 源语言，{{targetLanguage}} - 目标语言，{{sourceText}} - 原文，{{targetText}} - 当前翻译'}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* AI 优化结果 */}
                  <div className="space-y-2">
                    <Label>{t('aiOptimizedResult') || 'AI 优化结果'}</Label>
                    {aiOptimizing ? (
                      <div className="p-3 border rounded bg-muted/30 flex items-center justify-center">
                        <Loader2 className="h-5 w-5 animate-spin mr-2" />
                        {t('optimizing') || '优化中...'}
                      </div>
                    ) : optimizedText ? (
                      <Textarea
                        value={optimizedText}
                        onChange={(e) => setOptimizedText(e.target.value)}
                        className="min-h-[80px]"
                      />
                    ) : (
                      <div className="p-3 border rounded bg-muted/30 text-sm text-muted-foreground italic">
                        {t('clickOptimizeToStart') || '点击"开始优化"获取结果'}
                      </div>
                    )}
                  </div>
                </div>
              )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowAiOptimize(false)}
              >
                {t('cancel') || '取消'}
              </Button>
              <Button
                variant="secondary"
                onClick={handleAiOptimize}
                disabled={
                  aiOptimizing ||
                  currentSubtitleIndex < 0 ||
                  aiProviders.length === 0
                }
              >
                {aiOptimizing ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-1" />
                )}
                {t('startOptimize') || '开始优化'}
              </Button>
              <Button
                onClick={handleAcceptOptimization}
                disabled={!optimizedText || aiOptimizing}
              >
                {t('acceptOptimization') || '采纳'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 批量 AI 优化按钮 */}
      {shouldShowTranslation && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => setShowBatchOptimize(true)}
            disabled={subtitles.length === 0}
            title={t('batchAiOptimize') || '全文 AI 优化'}
          >
            <Wand2 className="h-4 w-4 mr-1" />
            {t('batchAiOptimize') || '全文优化'}
          </Button>

          <BatchAiOptimizeDialog
            open={showBatchOptimize}
            onOpenChange={setShowBatchOptimize}
            subtitles={subtitles}
            onApplyOptimizations={handleApplyBatchOptimizations}
            shouldShowTranslation={shouldShowTranslation}
          />
        </>
      )}
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
