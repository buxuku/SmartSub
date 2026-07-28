/**
 * 任务工具栏的「断句与精修」控件（openspec: add-ai-subtitle-refine）。
 *
 * 断句与精修的**唯一**配置入口（高级设置不再有断句方式，避免两处心智负担）：
 *  - 断句方式四选一：智能（maxSubtitleChars=0）/ 不限长（-1）/ 自定义上限（正数）/
 *    AI 语义断句（aiSegmentation=true，长度上限沿用 maxSubtitleChars，空=智能默认）；
 *  - AI 文本校正独立开关（aiCorrection）；
 *  - 任一 AI 能力开启时展示服务商行：默认跟随翻译服务，不可解析就地红字提示
 *    （向导 blockers 仍兜底阻断开始）。
 *
 * 工具栏按钮直接可读当前状态（如「AI 断句 · 校正」「≤ 40 字」），点开是白话弹层。
 * 「字幕效果」档位（转写引擎的抗幻觉/VAD 取舍）仍在高级设置——那是"识别得准不准"，
 * 这里是"断得好不好看"，物理分离降低概念混淆。
 */
import React, { useEffect, useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Sparkles } from 'lucide-react';
import { cn } from 'lib/utils';
import { isSherpaEngine } from 'lib/subtitleOutcome';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';

interface Provider {
  id: string;
  name: string;
  isAi?: boolean;
  [key: string]: any;
}

interface AiRefineControlProps {
  form: any;
  formData: any;
  providers: Provider[];
  typeDef: TaskTypeDef;
}

type SegmentationMode = 'smart' | 'unlimited' | 'custom' | 'ai';

const AiRefineControl: React.FC<AiRefineControlProps> = ({
  form,
  formData,
  providers,
  typeDef,
}) => {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');
  const { t: tCommon } = useTranslation('common');
  const [open, setOpen] = useState(false);

  const setValue = (name: string, value: unknown) =>
    form.setValue(name, value, { shouldDirty: true });

  // 断句方式：aiSegmentation 布尔 + maxSubtitleChars 三态编码 → 单一下拉四选一
  const segAiOn = formData?.aiSegmentation === true;
  const corrOn = formData?.aiCorrection === true;
  const rawWidth = Number(formData?.maxSubtitleChars ?? 0);
  const mode: SegmentationMode = segAiOn
    ? 'ai'
    : rawWidth < 0
      ? 'unlimited'
      : rawWidth > 0
        ? 'custom'
        : 'smart';

  // 字数草稿：custom 档「非法不回写」；ai 档「清空 = 智能默认(0)」
  const [widthDraft, setWidthDraft] = useState<string>(
    rawWidth > 0 ? String(rawWidth) : '',
  );
  useEffect(() => {
    setWidthDraft(rawWidth > 0 ? String(rawWidth) : '');
  }, [rawWidth]);

  const handleModeChange = (value: string) => {
    if (value === 'ai') {
      setValue('aiSegmentation', true);
      // 长度上限沿用当前 maxSubtitleChars（含「不限长」-1 → 关闭限长校验）
      return;
    }
    setValue('aiSegmentation', false);
    if (value === 'unlimited') {
      setValue('maxSubtitleChars', -1);
    } else if (value === 'custom') {
      const parsed = Number(widthDraft);
      setValue('maxSubtitleChars', parsed > 0 ? Math.round(parsed) : 40);
    } else {
      setValue('maxSubtitleChars', 0);
    }
  };

  // 服务商解析预览（与主进程 resolveRefineProvider 同一语义，仅展示与就地提示）
  const refineSetting = formData?.refineProvider || 'follow-translation';
  const aiProviders = providers.filter((p) => p?.isAi);
  const translateProviderObj = providers.find(
    (p) => p?.id === formData?.translateProvider,
  );
  const followResolvable = Boolean(
    typeDef.hasTranslate &&
      formData?.translateProvider !== '-1' &&
      translateProviderObj?.isAi,
  );
  const providerName = (p?: Provider) =>
    p ? tCommon(`provider.${p.name}`, { defaultValue: p.name }) : '';

  const needsProvider = segAiOn || corrOn;
  const sherpaApprox =
    isSherpaEngine(formData?.transcriptionEngine) ||
    formData?.transcriptionEngine === 'localCli';

  // 工具栏按钮的状态文案：断句方式 + 可选「· 校正」后缀
  const modeLabel =
    mode === 'ai'
      ? t('refine.control.state.ai')
      : mode === 'unlimited'
        ? t('refine.control.state.unlimited')
        : mode === 'custom'
          ? t('refine.control.state.custom', { n: rawWidth })
          : t('refine.control.state.smart');
  const stateLabel = corrOn
    ? `${modeLabel}${t('refine.control.state.corrSuffix')}`
    : modeLabel;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {t('refine.control.label')}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 text-xs',
              (segAiOn || corrOn) &&
                'border-primary/50 bg-primary/[0.06] text-primary hover:text-primary',
            )}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {stateLabel}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={12}
          // 高度约束到 Radix 计算的视口可用空间：内容过高时内部滚动，
          // 避免向上翻转后顶部溢出视口被遮挡
          className="w-[340px] max-h-[min(520px,calc(var(--radix-popover-content-available-height)-8px))] overflow-y-auto space-y-3"
        >
          <div>
            <p className="text-sm font-medium">{t('refine.control.title')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('refine.control.intro')}
            </p>
          </div>

          {/* 断句方式（四选一，唯一入口） */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t('subtitleLength.label')}
            </p>
            <Select value={mode} onValueChange={handleModeChange}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={tHome('pleaseSelect')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="smart">
                  {t('subtitleLength.modeSmart')}
                </SelectItem>
                <SelectItem value="ai">{t('subtitleLength.modeAi')}</SelectItem>
                <SelectItem value="custom">
                  {t('subtitleLength.modeCustom')}
                </SelectItem>
                <SelectItem value="unlimited">
                  {t('subtitleLength.modeUnlimited')}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {mode === 'smart' && t('subtitleLength.hintSmart')}
              {mode === 'unlimited' && t('subtitleLength.hintUnlimited')}
              {mode === 'custom' && t('subtitleLength.hintCustom')}
              {mode === 'ai' && t('subtitleLength.hintAi')}
            </p>

            {(mode === 'custom' || mode === 'ai') && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('refine.control.maxCharsLabel')}
                </p>
                <Input
                  type="number"
                  min={8}
                  max={120}
                  className="h-8 text-xs"
                  placeholder={
                    mode === 'ai'
                      ? t('refine.control.maxCharsPlaceholder')
                      : '40'
                  }
                  value={mode === 'ai' && rawWidth <= 0 ? '' : widthDraft}
                  onChange={(e) => {
                    const value = e.target.value;
                    setWidthDraft(value);
                    // ai 档清空 = 回到智能默认（0）；custom 档沿用「非法不回写」草稿语义
                    if (mode === 'ai' && value.trim() === '') {
                      setValue('maxSubtitleChars', 0);
                      return;
                    }
                    const parsed = Number(value);
                    if (Number.isFinite(parsed) && parsed > 0) {
                      setValue('maxSubtitleChars', Math.round(parsed));
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('refine.control.maxCharsHint')}
                </p>
              </div>
            )}

            {mode === 'ai' && sherpaApprox && (
              <p className="text-xs text-muted-foreground">
                {t('refine.approxNote')}
              </p>
            )}
          </div>

          {/* AI 文本校正 */}
          <div className="flex items-start justify-between gap-3 rounded-lg border p-2.5">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {t('refine.control.corrLabel')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('refine.control.corrHint')}
              </p>
            </div>
            <Switch
              checked={corrOn}
              onCheckedChange={(v) => setValue('aiCorrection', v === true)}
            />
          </div>

          {/* 服务商：任一 AI 能力开启时展示；默认跟随翻译服务 */}
          {needsProvider && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t('refine.provider.label')}
              </p>
              <Select
                value={refineSetting}
                onValueChange={(v) => setValue('refineProvider', v)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={tHome('pleaseSelect')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="follow-translation">
                    {followResolvable
                      ? t('refine.provider.follow', {
                          name: providerName(translateProviderObj),
                        })
                      : t('refine.provider.followUnavailable')}
                  </SelectItem>
                  {aiProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {providerName(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {refineSetting === 'follow-translation' && !followResolvable && (
                <p className="text-xs text-destructive">
                  {t('refine.provider.followBlocked')}
                </p>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default AiRefineControl;
