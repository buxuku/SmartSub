import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sparkles,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Play,
  Pause,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Subtitle } from '../../hooks/useSubtitles';

// 优化结果类型
interface OptimizationResult {
  id: string;
  index: number;
  sourceContent: string;
  originalTarget: string;
  optimizedTarget: string;
  status: 'success' | 'error' | 'skipped';
  error?: string;
  selected: boolean; // 是否选中采纳
}

interface BatchAiOptimizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subtitles: Subtitle[];
  onApplyOptimizations: (
    optimizations: Array<{ index: number; targetContent: string }>,
  ) => void;
  shouldShowTranslation: boolean;
}

export default function BatchAiOptimizeDialog({
  open,
  onOpenChange,
  subtitles,
  onApplyOptimizations,
  shouldShowTranslation,
}: BatchAiOptimizeDialogProps) {
  const { t } = useTranslation('home');

  // 状态
  const [step, setStep] = useState<'config' | 'running' | 'review'>('config');
  const [aiProviders, setAiProviders] = useState<any[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [batchSize, setBatchSize] = useState(5);
  const [showCustomPrompt, setShowCustomPrompt] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');

  // 进度状态
  const [progress, setProgress] = useState(0);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // 结果状态
  const [results, setResults] = useState<OptimizationResult[]>([]);
  const [summary, setSummary] = useState<{
    total: number;
    success: number;
    error: number;
    skipped: number;
  } | null>(null);

  // 提示词缓存 key
  const BATCH_PROMPT_CACHE_KEY = 'ai_batch_optimize_prompt';

  // 默认批量优化提示词
  const defaultBatchPrompt = `You are a professional subtitle translator and proofreader.

For each subtitle, optimize the translation ({{targetLanguage}}) based on the original text ({{sourceLanguage}}):
1. More accurately convey the original meaning
2. Use natural and fluent expressions
3. Be appropriate for subtitle display
4. Maintain the original tone and style

IMPORTANT: Return ONLY a valid JSON object with subtitle IDs as keys and optimized translations as string values.`;

  // 加载 AI 服务商
  const loadAiProviders = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('getAiTranslationProviders');
      if (result.success && result.data) {
        setAiProviders(result.data);
        if (result.data.length > 0 && !selectedProviderId) {
          setSelectedProviderId(result.data[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to load AI providers:', error);
    }
  }, [selectedProviderId]);

  // 加载缓存的提示词
  const loadCachedPrompt = useCallback(() => {
    try {
      const cached = localStorage.getItem(BATCH_PROMPT_CACHE_KEY);
      if (cached) {
        setCustomPrompt(cached);
        setShowCustomPrompt(true);
      } else {
        setCustomPrompt(defaultBatchPrompt);
      }
    } catch {
      setCustomPrompt(defaultBatchPrompt);
    }
  }, [defaultBatchPrompt]);

  // 保存提示词到缓存
  const savePromptToCache = useCallback(
    (prompt: string) => {
      try {
        if (prompt.trim() !== defaultBatchPrompt.trim()) {
          localStorage.setItem(BATCH_PROMPT_CACHE_KEY, prompt);
        } else {
          localStorage.removeItem(BATCH_PROMPT_CACHE_KEY);
        }
      } catch {}
    },
    [defaultBatchPrompt],
  );

  // 初始化
  useEffect(() => {
    if (open) {
      loadAiProviders();
      loadCachedPrompt();
      // 重置状态
      setStep('config');
      setProgress(0);
      setResults([]);
      setSummary(null);
      setIsRunning(false);
      setIsPaused(false);
    }
  }, [open, loadAiProviders, loadCachedPrompt]);

  // 监听进度事件
  useEffect(() => {
    if (!open) return;

    const handleProgress = (progressData: {
      progress: number;
      currentBatch: number;
      totalBatches: number;
      processedCount: number;
      totalCount: number;
      completed?: boolean;
    }) => {
      setProgress(progressData.progress);
      setCurrentBatch(progressData.currentBatch);
      setTotalBatches(progressData.totalBatches);
      setProcessedCount(progressData.processedCount);
    };

    // window.ipc.on returns a cleanup function
    const cleanup = window.ipc.on('batchOptimizeProgress', handleProgress);

    return cleanup;
  }, [open]);

  // 开始批量优化
  const handleStartOptimization = useCallback(async () => {
    if (aiProviders.length === 0) {
      toast.error(t('noAiProviderConfigured') || '请先配置 AI 翻译服务');
      return;
    }

    // 准备字幕数据
    const subtitlesToOptimize = subtitles
      .map((sub, index) => ({
        id: sub.id || String(index),
        index,
        sourceContent: sub.sourceContent || '',
        targetContent: sub.targetContent || '',
      }))
      .filter((sub) => sub.sourceContent.trim()); // 过滤空字幕

    if (subtitlesToOptimize.length === 0) {
      toast.error(t('noSubtitlesToOptimize') || '没有可优化的字幕');
      return;
    }

    setStep('running');
    setIsRunning(true);
    setProgress(0);
    setProcessedCount(0);

    try {
      // 保存自定义提示词
      savePromptToCache(customPrompt);

      const result = await window.ipc.invoke('batchOptimizeSubtitles', {
        subtitles: subtitlesToOptimize,
        providerId: selectedProviderId,
        customPrompt: customPrompt.trim() || undefined,
        batchSize,
        maxRetries: 2,
      });

      if (result.success && result.data) {
        // 处理结果
        const optimizationResults: OptimizationResult[] =
          result.data.results.map((r: any) => ({
            ...r,
            selected:
              r.status === 'success' && r.optimizedTarget !== r.originalTarget,
          }));

        setResults(optimizationResults);
        setSummary(result.data.summary);
        setStep('review');
        toast.success(
          t('batchOptimizeCompleted') ||
            `优化完成：${result.data.summary.success}/${result.data.summary.total} 条成功`,
        );
      } else {
        toast.error(result.error || t('batchOptimizeFailed') || '批量优化失败');
        setStep('config');
      }
    } catch (error) {
      console.error('Batch optimization error:', error);
      toast.error(t('batchOptimizeFailed') || '批量优化失败');
      setStep('config');
    } finally {
      setIsRunning(false);
    }
  }, [
    subtitles,
    selectedProviderId,
    customPrompt,
    batchSize,
    aiProviders,
    savePromptToCache,
    t,
  ]);

  // 切换选中状态
  const toggleResultSelection = useCallback((id: string) => {
    setResults((prev) =>
      prev.map((r) => (r.id === id ? { ...r, selected: !r.selected } : r)),
    );
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback((selected: boolean) => {
    setResults((prev) =>
      prev.map((r) =>
        r.status === 'success' && r.optimizedTarget !== r.originalTarget
          ? { ...r, selected }
          : r,
      ),
    );
  }, []);

  // 应用选中的优化结果
  const handleApplyOptimizations = useCallback(() => {
    const selectedResults = results.filter((r) => r.selected);
    if (selectedResults.length === 0) {
      toast.warning(t('noOptimizationsSelected') || '请选择要采纳的优化结果');
      return;
    }

    const optimizations = selectedResults.map((r) => ({
      index: r.index,
      targetContent: r.optimizedTarget,
    }));

    onApplyOptimizations(optimizations);
    onOpenChange(false);
    toast.success(
      t('optimizationsApplied', { count: optimizations.length }) ||
        `已应用 ${optimizations.length} 条优化`,
    );
  }, [results, onApplyOptimizations, onOpenChange, t]);

  // 返回配置页
  const handleBackToConfig = useCallback(() => {
    setStep('config');
    setResults([]);
    setSummary(null);
  }, []);

  // 获取选中数量
  const selectedCount = results.filter((r) => r.selected).length;
  const selectableCount = results.filter(
    (r) => r.status === 'success' && r.optimizedTarget !== r.originalTarget,
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            {step === 'config' && (t('batchAiOptimize') || '全文 AI 优化')}
            {step === 'running' && (t('optimizing') || '优化中...')}
            {step === 'review' && (t('reviewResults') || '审核结果')}
          </DialogTitle>
          <DialogDescription>
            {step === 'config' &&
              (t('batchAiOptimizeDesc') ||
                '使用 AI 批量优化所有字幕翻译，优化后可逐条审核并选择是否采纳')}
            {step === 'running' &&
              (t('batchOptimizeRunningDesc') ||
                '正在批量处理字幕优化，请稍候...')}
            {step === 'review' &&
              (t('batchOptimizeReviewDesc') ||
                '请审核优化结果，选择要采纳的条目')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden min-h-0">
          {/* 配置页面 */}
          {step === 'config' && (
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

              {/* 批次大小 */}
              <div className="space-y-2">
                <Label>{t('batchSize') || '每批处理数量'}</Label>
                <div className="flex items-center gap-4">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={batchSize}
                    onChange={(e) =>
                      setBatchSize(
                        Math.max(
                          1,
                          Math.min(20, parseInt(e.target.value) || 5),
                        ),
                      )
                    }
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">
                    {t('batchSizeHint') || '建议 3-10 条，过大可能导致超时'}
                  </span>
                </div>
              </div>

              {/* 待优化字幕统计 */}
              <div className="p-3 border rounded bg-muted/30">
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {t('subtitlesToOptimize') || '待优化字幕'}
                  </span>
                  <Badge variant="secondary">
                    {subtitles.filter((s) => s.sourceContent?.trim()).length}{' '}
                    {t('items') || '条'}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('estimatedBatches') || '预计批次'}:{' '}
                  {Math.ceil(
                    subtitles.filter((s) => s.sourceContent?.trim()).length /
                      batchSize,
                  )}
                </div>
              </div>

              {/* 自定义提示词 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('customPrompt') || '自定义提示词'}</Label>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setCustomPrompt(defaultBatchPrompt);
                        localStorage.removeItem(BATCH_PROMPT_CACHE_KEY);
                      }}
                    >
                      {t('resetToDefault') || '重置'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowCustomPrompt(!showCustomPrompt)}
                    >
                      {showCustomPrompt ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
                {showCustomPrompt && (
                  <div className="space-y-2">
                    <Textarea
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      className="min-h-[150px] text-sm font-mono"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('batchPromptHint') ||
                        '支持变量：{{sourceLanguage}}、{{targetLanguage}}'}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 运行中页面 */}
          {step === 'running' && (
            <div className="space-y-6 py-8">
              <div className="text-center">
                <Loader2 className="h-12 w-12 animate-spin mx-auto mb-4 text-primary" />
                <p className="text-lg font-medium">
                  {t('batchOptimizing') || '正在批量优化...'}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>
                    {t('progress') || '进度'}: {processedCount}/
                    {subtitles.filter((s) => s.sourceContent?.trim()).length}
                  </span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} />
                <p className="text-sm text-muted-foreground text-center">
                  {t('processingBatch') || '正在处理批次'} {currentBatch}/
                  {totalBatches}
                </p>
              </div>
            </div>
          )}

          {/* 审核页面 */}
          {step === 'review' && (
            <div className="flex flex-col h-[60vh]">
              {/* 统计摘要 */}
              {summary && (
                <div className="flex items-center gap-4 p-3 border rounded bg-muted/30 mb-4 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    <span className="text-sm">
                      {t('successCount') || '成功'}: {summary.success}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-red-500" />
                    <span className="text-sm">
                      {t('errorCount') || '失败'}: {summary.error}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-yellow-500" />
                    <span className="text-sm">
                      {t('skippedCount') || '跳过'}: {summary.skipped}
                    </span>
                  </div>
                  <div className="flex-1" />
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="select-all"
                      checked={
                        selectedCount > 0 && selectedCount === selectableCount
                      }
                      onCheckedChange={(checked) =>
                        toggleSelectAll(checked as boolean)
                      }
                    />
                    <label htmlFor="select-all" className="text-sm">
                      {t('selectAll') || '全选'} ({selectedCount}/
                      {selectableCount})
                    </label>
                  </div>
                </div>
              )}

              {/* 结果列表 */}
              <ScrollArea className="flex-1 border rounded min-h-0">
                <div className="divide-y">
                  {results.map((result, idx) => (
                    <div
                      key={result.id}
                      className={`p-3 ${
                        result.status === 'error'
                          ? 'bg-red-50 dark:bg-red-950/20'
                          : result.status === 'skipped'
                            ? 'bg-yellow-50 dark:bg-yellow-950/20'
                            : ''
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {/* 选择框 */}
                        <div className="pt-1">
                          <Checkbox
                            checked={result.selected}
                            onCheckedChange={() =>
                              toggleResultSelection(result.id)
                            }
                            disabled={
                              result.status !== 'success' ||
                              result.optimizedTarget === result.originalTarget
                            }
                          />
                        </div>

                        {/* 内容 */}
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-xs">
                              #{result.index + 1}
                            </Badge>
                            {result.status === 'success' ? (
                              result.optimizedTarget !==
                              result.originalTarget ? (
                                <Badge
                                  variant="default"
                                  className="text-xs bg-green-500"
                                >
                                  {t('changed') || '已优化'}
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="text-xs">
                                  {t('unchanged') || '无变化'}
                                </Badge>
                              )
                            ) : result.status === 'error' ? (
                              <Badge variant="destructive" className="text-xs">
                                {t('error') || '错误'}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">
                                {t('skipped') || '跳过'}
                              </Badge>
                            )}
                          </div>

                          {/* 原文 */}
                          <div className="text-sm text-muted-foreground">
                            {result.sourceContent}
                          </div>

                          {/* 对比显示 */}
                          {result.status === 'success' &&
                            result.optimizedTarget !==
                              result.originalTarget && (
                              <div className="grid grid-cols-2 gap-2">
                                <div className="p-2 bg-muted/50 rounded text-sm">
                                  <div className="text-xs text-muted-foreground mb-1">
                                    {t('originalTranslation') || '原翻译'}
                                  </div>
                                  {result.originalTarget || (
                                    <span className="italic text-muted-foreground">
                                      ({t('empty') || '空'})
                                    </span>
                                  )}
                                </div>
                                <div className="p-2 bg-green-50 dark:bg-green-950/30 rounded text-sm border border-green-200 dark:border-green-800">
                                  <div className="text-xs text-green-600 dark:text-green-400 mb-1">
                                    {t('optimizedTranslation') || '优化后'}
                                  </div>
                                  {result.optimizedTarget}
                                </div>
                              </div>
                            )}

                          {/* 错误信息 */}
                          {result.error && (
                            <div className="text-xs text-red-500">
                              {result.error}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0">
          {step === 'config' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('cancel') || '取消'}
              </Button>
              <Button
                onClick={handleStartOptimization}
                disabled={
                  aiProviders.length === 0 ||
                  subtitles.filter((s) => s.sourceContent?.trim()).length === 0
                }
              >
                <Play className="h-4 w-4 mr-1" />
                {t('startBatchOptimize') || '开始优化'}
              </Button>
            </>
          )}

          {step === 'running' && (
            <Button variant="outline" disabled>
              {t('processing') || '处理中...'}
            </Button>
          )}

          {step === 'review' && (
            <>
              <Button variant="outline" onClick={handleBackToConfig}>
                <RotateCcw className="h-4 w-4 mr-1" />
                {t('reoptimize') || '重新优化'}
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('cancel') || '取消'}
              </Button>
              <Button
                onClick={handleApplyOptimizations}
                disabled={selectedCount === 0}
              >
                <CheckCircle2 className="h-4 w-4 mr-1" />
                {t('applySelected', { count: selectedCount }) ||
                  `应用选中 (${selectedCount})`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
