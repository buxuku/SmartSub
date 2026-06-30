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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isProviderConfigured } from 'lib/providerUtils';
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
  X,
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

  // 纯转写模式：优化对象是原文（修正转写错误），不做翻译
  const isTranscriptMode = !shouldShowTranslation;

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
  const [isCancelling, setIsCancelling] = useState(false);
  const [wasCancelled, setWasCancelled] = useState(false);
  // 当前批量任务的取消句柄 id
  const batchIdRef = useRef<string | null>(null);

  // 结果状态
  const [results, setResults] = useState<OptimizationResult[]>([]);
  const [summary, setSummary] = useState<{
    total: number;
    success: number;
    error: number;
    skipped: number;
  } | null>(null);

  // 提示词缓存 key（按模式区分，避免翻译/校对提示词互相覆盖）
  const BATCH_PROMPT_CACHE_KEY = isTranscriptMode
    ? 'ai_batch_proofread_prompt'
    : 'ai_batch_optimize_prompt';

  // 默认批量优化提示词（翻译优化 / 转写校对两套）
  const defaultBatchPrompt = isTranscriptMode
    ? `You are a professional subtitle proofreader.

Each subtitle below is an automatic speech-to-text transcription ({{sourceLanguage}}) that may contain recognition errors. The "source" and "target" fields contain the same transcribed text; correct it:
1. Fix misrecognized words based on context
2. Fix punctuation and casing
3. Keep the original meaning and wording as much as possible
4. Do NOT translate, summarize, or rephrase

IMPORTANT: Return ONLY a valid JSON object with subtitle IDs as keys and corrected texts as string values.`
    : `You are a professional subtitle translator and proofreader.

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
        // 默认优先选中已配置的服务商，避免默认落到不可用项
        if (result.data.length > 0 && !selectedProviderId) {
          const firstConfigured = result.data.find((p: any) =>
            isProviderConfigured(p),
          );
          if (firstConfigured) setSelectedProviderId(firstConfigured.id);
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
  }, [defaultBatchPrompt, BATCH_PROMPT_CACHE_KEY]);

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
    [defaultBatchPrompt, BATCH_PROMPT_CACHE_KEY],
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
      setIsCancelling(false);
      setWasCancelled(false);
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
    if (!aiProviders.some((p) => isProviderConfigured(p))) {
      toast.error(t('noAiProviderConfigured'));
      return;
    }

    // 准备字幕数据（转写校对模式下 target 即原文，便于"无变化"对比与统一回传格式）
    const subtitlesToOptimize = subtitles
      .map((sub, index) => ({
        id: sub.id || String(index),
        index,
        sourceContent: sub.sourceContent || '',
        targetContent: isTranscriptMode
          ? sub.sourceContent || ''
          : sub.targetContent || '',
      }))
      .filter((sub) => sub.sourceContent.trim()); // 过滤空字幕

    if (subtitlesToOptimize.length === 0) {
      toast.error(t('noSubtitlesToOptimize'));
      return;
    }

    setStep('running');
    setIsRunning(true);
    setIsCancelling(false);
    setWasCancelled(false);
    setProgress(0);
    setProcessedCount(0);

    // 生成取消句柄 id
    const batchId = `batch-optimize-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    batchIdRef.current = batchId;

    try {
      // 保存自定义提示词
      savePromptToCache(customPrompt);

      const result = await window.ipc.invoke('batchOptimizeSubtitles', {
        subtitles: subtitlesToOptimize,
        providerId: selectedProviderId,
        customPrompt: customPrompt.trim() || undefined,
        batchSize,
        maxRetries: 2,
        batchId,
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
        setWasCancelled(!!result.cancelled);

        if (result.cancelled && optimizationResults.length === 0) {
          // 取消且无任何完成结果：回到配置页
          toast.info(t('batchOptimizeCancelled'));
          setStep('config');
        } else {
          setStep('review');
          if (result.cancelled) {
            toast.info(t('batchOptimizeCancelledPartial'));
          } else {
            toast.success(
              t('batchOptimizeCompleted') ||
                `优化完成：${result.data.summary.success}/${result.data.summary.total} 条成功`,
            );
          }
        }
      } else {
        toast.error(result.error || t('batchOptimizeFailed'));
        setStep('config');
      }
    } catch (error) {
      console.error('Batch optimization error:', error);
      toast.error(t('batchOptimizeFailed'));
      setStep('config');
    } finally {
      setIsRunning(false);
      setIsCancelling(false);
      batchIdRef.current = null;
    }
  }, [
    subtitles,
    selectedProviderId,
    customPrompt,
    batchSize,
    aiProviders,
    savePromptToCache,
    isTranscriptMode,
    t,
  ]);

  // 取消批量优化（主进程在批次边界停止并返回部分结果）
  const handleCancelOptimization = useCallback(async () => {
    if (!batchIdRef.current || isCancelling) return;
    setIsCancelling(true);
    try {
      await window.ipc.invoke('cancelProofreadBatch', {
        batchId: batchIdRef.current,
      });
    } catch (error) {
      console.error('Cancel batch optimization error:', error);
    }
  }, [isCancelling]);

  // 运行中关闭弹窗：先发取消，避免主进程循环继续空跑
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && isRunning) {
        handleCancelOptimization();
      }
      onOpenChange(nextOpen);
    },
    [isRunning, handleCancelOptimization, onOpenChange],
  );

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
      toast.warning(t('noOptimizationsSelected'));
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            {step === 'config' &&
              (isTranscriptMode ? t('batchAiProofread') : t('batchAiOptimize'))}
            {step === 'running' && t('optimizing')}
            {step === 'review' && t('reviewResults')}
          </DialogTitle>
          <DialogDescription>
            {step === 'config' &&
              (isTranscriptMode
                ? t('batchAiProofreadDesc')
                : t('batchAiOptimizeDesc'))}
            {step === 'running' && t('batchOptimizeRunningDesc')}
            {step === 'review' && t('batchOptimizeReviewDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden min-h-0">
          {/* 配置页面 */}
          {step === 'config' && (
            <div className="space-y-4 py-4">
              {/* AI 服务商选择 */}
              <div className="space-y-2">
                <Label>{t('selectAiProvider')}</Label>
                {!aiProviders.some((p) => isProviderConfigured(p)) ? (
                  <div className="p-3 border rounded bg-muted/30 text-sm text-muted-foreground italic">
                    {t('noAiProviderConfigured')}
                  </div>
                ) : (
                  <Select
                    value={selectedProviderId}
                    onValueChange={setSelectedProviderId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('selectProvider')} />
                    </SelectTrigger>
                    <SelectContent>
                      {aiProviders.some((p) => isProviderConfigured(p)) && (
                        <SelectGroup>
                          <SelectLabel className="flex items-center gap-1.5 pl-2 text-foreground">
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                            {t('providerGroup.configured')}
                          </SelectLabel>
                          {aiProviders
                            .filter((p) => isProviderConfigured(p))
                            .map((provider) => (
                              <SelectItem key={provider.id} value={provider.id}>
                                {provider.name}
                              </SelectItem>
                            ))}
                        </SelectGroup>
                      )}
                      {aiProviders.some((p) => !isProviderConfigured(p)) && (
                        <SelectGroup>
                          <SelectLabel className="flex items-center gap-1.5 pl-2 text-muted-foreground">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {t('providerGroup.notConfigured')}
                          </SelectLabel>
                          {aiProviders
                            .filter((p) => !isProviderConfigured(p))
                            .map((provider) => (
                              <SelectItem
                                key={provider.id}
                                value={provider.id}
                                disabled
                              >
                                {provider.name}
                                {t('notConfigured')}
                              </SelectItem>
                            ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* 批次大小 */}
              <div className="space-y-2">
                <Label>{t('batchSize')}</Label>
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
                    {t('batchSizeHint')}
                  </span>
                </div>
              </div>

              {/* 待优化字幕统计 */}
              <div className="p-3 border rounded bg-muted/30">
                <div className="flex items-center justify-between">
                  <span className="text-sm">{t('subtitlesToOptimize')}</span>
                  <Badge variant="secondary">
                    {subtitles.filter((s) => s.sourceContent?.trim()).length}{' '}
                    {t('items')}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('estimatedBatches')}:{' '}
                  {Math.ceil(
                    subtitles.filter((s) => s.sourceContent?.trim()).length /
                      batchSize,
                  )}
                </div>
              </div>

              {/* 自定义提示词 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('customPrompt')}</Label>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        setCustomPrompt(defaultBatchPrompt);
                        localStorage.removeItem(BATCH_PROMPT_CACHE_KEY);
                      }}
                    >
                      <RotateCcw className="h-4 w-4" />
                      {t('resetToDefault')}
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
                      {t('batchPromptHint')}
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
                <p className="text-lg font-medium">{t('batchOptimizing')}</p>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>
                    {t('progress')}: {processedCount}/
                    {subtitles.filter((s) => s.sourceContent?.trim()).length}
                  </span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} />
                <p className="text-sm text-muted-foreground text-center">
                  {t('processingBatch')} {currentBatch}/{totalBatches}
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
                  {wasCancelled && (
                    <Badge
                      variant="outline"
                      className="text-xs border-warning/60 text-warning"
                    >
                      {t('batchOptimizeCancelledBadge')}
                    </Badge>
                  )}
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    <span className="text-sm">
                      {t('successCount')}: {summary.success}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-destructive" />
                    <span className="text-sm">
                      {t('errorCount')}: {summary.error}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <span className="text-sm">
                      {t('skippedCount')}: {summary.skipped}
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
                      {t('selectAll')} ({selectedCount}/{selectableCount})
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
                          ? 'bg-destructive/10'
                          : result.status === 'skipped'
                            ? 'bg-warning/10'
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
                                  className="text-xs bg-success"
                                >
                                  {t('changed')}
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="text-xs">
                                  {t('unchanged')}
                                </Badge>
                              )
                            ) : result.status === 'error' ? (
                              <Badge variant="destructive" className="text-xs">
                                {t('error')}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">
                                {t('skipped')}
                              </Badge>
                            )}
                          </div>

                          {/* 原文（转写校对模式下有变化时对比区已展示原文，避免重复） */}
                          {(!isTranscriptMode ||
                            result.status !== 'success' ||
                            result.optimizedTarget ===
                              result.originalTarget) && (
                            <div className="text-sm text-muted-foreground">
                              {result.sourceContent}
                            </div>
                          )}

                          {/* 对比显示 */}
                          {result.status === 'success' &&
                            result.optimizedTarget !==
                              result.originalTarget && (
                              <div className="grid grid-cols-2 gap-2">
                                <div className="p-2 bg-muted/50 rounded text-sm">
                                  <div className="text-xs text-muted-foreground mb-1">
                                    {isTranscriptMode
                                      ? t('sourceText')
                                      : t('originalTranslation')}
                                  </div>
                                  {result.originalTarget || (
                                    <span className="italic text-muted-foreground">
                                      ({t('empty')})
                                    </span>
                                  )}
                                </div>
                                <div className="p-2 bg-success/10 rounded text-sm border border-success/30">
                                  <div className="text-xs text-success mb-1">
                                    {isTranscriptMode
                                      ? t('correctedText')
                                      : t('optimizedTranslation')}
                                  </div>
                                  {result.optimizedTarget}
                                </div>
                              </div>
                            )}

                          {/* 错误信息 */}
                          {result.error && (
                            <div className="text-xs text-destructive">
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
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" />
                {t('cancel')}
              </Button>
              <Button
                onClick={handleStartOptimization}
                disabled={
                  !aiProviders.some((p) => isProviderConfigured(p)) ||
                  subtitles.filter((s) => s.sourceContent?.trim()).length === 0
                }
              >
                <Play className="h-4 w-4 mr-1" />
                {t('startBatchOptimize')}
              </Button>
            </>
          )}

          {step === 'running' && (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={handleCancelOptimization}
              disabled={isCancelling}
            >
              <X className="h-4 w-4" />
              {isCancelling ? t('cancelling') : t('cancel')}
            </Button>
          )}

          {step === 'review' && (
            <>
              <Button variant="outline" onClick={handleBackToConfig}>
                <RotateCcw className="h-4 w-4 mr-1" />
                {t('reoptimize')}
              </Button>
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" />
                {t('cancel')}
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
