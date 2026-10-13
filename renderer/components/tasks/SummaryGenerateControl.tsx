/**
 * 任务配置条：通读摘要入口。
 *
 * 与「场景」「断句与精修」「字幕格式」同构：配置条里只放一个 h-8 的状态按钮，
 * 开关、摘要服务、提示词入口都收进弹层，因此配置条的尺寸不会随开关状态变化。
 * 状态直接写在按钮上（关闭 / 服务名 / 待配置）：generateSummary 与 summaryProvider
 * 会作为下一个任务的默认值被记住，一个会多花一次 AI 调用的开关不能藏起来。
 *
 * 字段层可用 follow-translation 哨兵；下拉只列已配置 AI，不出现「跟随」条目。
 * 可用性判定统一走 validateSummaryProvider，与开始任务时的阻断是同一个函数。
 */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
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
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  ChevronDown,
  ChevronRight,
  Languages,
  ScrollText,
  TriangleAlert,
} from 'lucide-react';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import type { UseFormReturn } from 'react-hook-form';
import SummaryPromptDialog from '@/components/resources/SummaryPromptDialog';
import { useSummaryPromptCustomized } from 'hooks/useSummaryPromptCustomized';
import { FOLLOW_TRANSLATION_PROVIDER } from '../../../types/summaryPrompt';
import type { Provider } from '../../../types/provider';
import {
  isUsableSummaryProvider,
  validateSummaryProvider,
  type SummaryControlProvider,
} from '../../../types/summaryProvider';
import type { IFormData } from '../../../types/types';

interface SummaryGenerateControlProps {
  form: Pick<UseFormReturn<IFormData>, 'setValue'>;
  formData: IFormData | undefined;
  providers: SummaryControlProvider[];
  /** 受控展开：被摘要配置阻断时，「调整摘要」靠它唤起弹层。不传则自管。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const SummaryGenerateControl: React.FC<SummaryGenerateControlProps> = ({
  form,
  formData,
  providers,
  open: controlledOpen,
  onOpenChange: onControlledOpenChange,
  className,
}) => {
  const { t } = useTranslation('tasks');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const { locale } = router.query;

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = typeof controlledOpen === 'boolean';
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (nextOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(nextOpen);
    }
    onControlledOpenChange?.(nextOpen);
  };

  // 提示词编辑弹窗与弹层同级渲染：先关弹层再开弹窗，不做 Popover 套 Dialog
  const [promptOpen, setPromptOpen] = useState(false);
  const openingPromptRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { customized, refresh: refreshCustomized } =
    useSummaryPromptCustomized();

  useEffect(() => {
    if (open) void refreshCustomized();
  }, [open, refreshCustomized]);

  const openPromptEditor = () => {
    openingPromptRef.current = true;
    setOpen(false);
    setPromptOpen(true);
  };

  const handlePromptOpenChange = (nextOpen: boolean) => {
    setPromptOpen(nextOpen);
    // 弹窗关闭时编辑已 flush，刷新「已自定义」徽标
    if (!nextOpen) void refreshCustomized();
  };

  const enabled = formData?.generateSummary === true;
  const aiProviders = providers.filter((provider) =>
    isUsableSummaryProvider(provider),
  );
  const translateProvider = providers.find(
    (provider) => provider.id === formData?.translateProvider,
  );
  const translateIsAi = isUsableSummaryProvider(translateProvider);
  const setting = formData?.summaryProvider || FOLLOW_TRANSLATION_PROVIDER;
  const following = setting === FOLLOW_TRANSLATION_PROVIDER;
  const selectValue = following
    ? translateIsAi
      ? translateProvider?.id || ''
      : ''
    : setting;
  const injectsIntoTranslate = Boolean(translateProvider?.isAi);

  // 与开始任务时的阻断同一个判定，避免界面提示与阻断逻辑分叉
  const blockReason = enabled
    ? validateSummaryProvider(formData, providers as Provider[])
    : null;
  const hasError = blockReason !== null;

  const providerName = (provider?: SummaryControlProvider) =>
    provider
      ? tCommon(`provider.${provider.name}`, { defaultValue: provider.name })
      : '';
  const effectiveProvider = following
    ? translateProvider
    : providers.find((provider) => provider.id === setting);

  // 触发按钮的状态文案：关闭 / 待配置 / 当前使用的服务名
  const stateLabel = !enabled
    ? t('configBar.summaryStateOff')
    : hasError
      ? t('configBar.summaryStateWarning')
      : providerName(effectiveProvider);
  const fullLabel = `${t('configBar.generateSummary')}: ${stateLabel}`;

  return (
    <div
      id="summary-control-container"
      className={cn('w-full min-w-0 scroll-mt-20', className)}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            size="sm"
            data-testid="summary-control-trigger"
            aria-label={fullLabel}
            title={fullLabel}
            className={cn(
              'h-8 w-full min-w-0 text-xs gap-1 px-2.5 font-normal justify-between',
              hasError
                ? 'border-warning/60 bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning'
                : enabled
                  ? 'border-primary/50 bg-primary/[0.06] text-primary hover:text-primary'
                  : 'border-dashed text-muted-foreground hover:text-foreground',
            )}
          >
            <div className="flex items-center gap-1.5 min-w-0 truncate">
              {hasError ? (
                <TriangleAlert className="h-3.5 w-3.5 flex-none text-warning" />
              ) : (
                <ScrollText className="h-3.5 w-3.5 flex-none" />
              )}
              <span className="truncate">{stateLabel}</span>
            </div>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-50 ml-1" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={12}
          // 高度约束到 Radix 计算的视口可用空间：内容过高时内部滚动，
          // 避免向上翻转后顶部溢出视口被遮挡
          className="w-[340px] max-h-[min(520px,calc(var(--radix-popover-content-available-height)-8px))] overflow-y-auto space-y-3"
          onCloseAutoFocus={(event) => {
            // 正在切到提示词弹窗：别把焦点抢回触发按钮
            if (openingPromptRef.current) {
              event.preventDefault();
              openingPromptRef.current = false;
            }
          }}
        >
          <div>
            <p className="text-sm font-medium">
              {t('configBar.generateSummary')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('configBar.summaryIntro')}
            </p>
          </div>

          {/* 开关：没有任何可用 AI 服务时不能开启，已开启的仍可关闭 */}
          <div className="flex items-start justify-between gap-3 rounded-lg border p-2.5">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {t('configBar.summaryEnableLabel')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('configBar.summaryEnableHint')}
              </p>
            </div>
            <Switch
              checked={enabled}
              disabled={!enabled && aiProviders.length === 0}
              aria-label={t('configBar.summaryEnableLabel')}
              onCheckedChange={(checked) =>
                form.setValue('generateSummary', checked, {
                  shouldDirty: true,
                })
              }
            />
          </div>

          {aiProviders.length === 0 && (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/[0.06] p-2.5">
              <p className="text-xs text-warning">
                {t('configBar.summaryProviderMissing')}
              </p>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
              >
                <Link href={`/${locale}/translation`}>
                  <Languages className="h-3.5 w-3.5" />
                  {t('configBar.summaryGoConfigure')}
                </Link>
              </Button>
            </div>
          )}

          {/* 摘要服务：仅开启且有可选 AI 服务时展示 */}
          {enabled && aiProviders.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t('configBar.summaryProvider')}
              </p>
              <Select
                value={selectValue || undefined}
                onValueChange={(value) =>
                  form.setValue('summaryProvider', value, {
                    shouldDirty: true,
                  })
                }
              >
                <SelectTrigger
                  className="h-8 text-xs"
                  aria-label={t('configBar.summaryProvider')}
                >
                  <SelectValue
                    placeholder={t('configBar.summaryProviderPlaceholder')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {aiProviders.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {providerName(provider)}
                      {following &&
                        translateIsAi &&
                        provider.id === translateProvider?.id &&
                        t('configBar.summaryFollowHint')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {blockReason === 'follow' && (
                <p className="text-xs text-destructive">
                  {t('wizard.blockSummaryFollow')}
                </p>
              )}
              {blockReason === 'invalid' && (
                <p className="text-xs text-destructive">
                  {t('wizard.blockSummaryProviderInvalid')}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('configBar.summarySkipHint')}
              </p>
              {/* 被阻断时上面的红字已经说明了「翻译服务不是 AI」，不再重复提示；
                  选好摘要服务之后这条才解释「摘要仅供对照」 */}
              {!injectsIntoTranslate && blockReason === null && (
                <p className="text-xs text-warning">
                  {t('configBar.summaryNotInjectedHint')}
                </p>
              )}
            </div>
          )}

          {/* 全局提示词：低频，弹层里留一个入口，在原位弹窗编辑 */}
          <div className="border-t pt-2">
            <button
              type="button"
              onClick={openPromptEditor}
              className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  {t('configBar.summaryEditPrompt')}
                  {customized && (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">
                      {t('configBar.summaryPromptCustomized')}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {t('configBar.summaryEditPromptHint')}
                </span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <SummaryPromptDialog
        open={promptOpen}
        onOpenChange={handlePromptOpenChange}
        returnFocusRef={triggerRef}
      />
    </div>
  );
};

export default SummaryGenerateControl;
