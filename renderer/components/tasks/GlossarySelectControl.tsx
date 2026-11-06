/**
 * 任务配置条的词库多选。未交互时 formData.glossaryIds 保持 undefined
 * （回落全部已启用）；勾选后写入显式 id 数组，取消最后一项得到 []。
 *
 * 只渲染控件本身（标签由 InlineConfigBar 的 ConfigItem 提供），触发器宽度跟随容器，
 * 与场景 / 断句与精修 / 字幕格式同构：不依赖内容撑宽，状态变化不会挤压整条配置条。
 */
import React, { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { BookOpenText, ChevronDown } from 'lucide-react';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import type { UseFormReturn } from 'react-hook-form';
import { useGlossaries } from 'hooks/useGlossaries';
import type { IFormData } from '../../../types/types';

interface GlossarySelectControlProps {
  form: Pick<UseFormReturn<IFormData>, 'setValue'>;
  formData: IFormData | undefined;
}

const GlossarySelectControl: React.FC<GlossarySelectControlProps> = ({
  form,
  formData,
}) => {
  const { t } = useTranslation('tasks');
  const router = useRouter();
  const { locale } = router.query;
  const [open, setOpen] = useState(false);
  const idBase = useId();
  const { glossaries, loading } = useGlossaries();

  const rawIds = formData?.glossaryIds;
  const isExplicit = Array.isArray(rawIds);
  const selectedIds: string[] = isExplicit ? rawIds : [];

  const enabledIds = glossaries
    .filter((glossary) => glossary.enabled)
    .map((glossary) => glossary.id);

  const isChecked = (id: string) =>
    isExplicit ? selectedIds.includes(id) : enabledIds.includes(id);

  const toggle = (id: string, checked: boolean) => {
    const current = isExplicit ? selectedIds : enabledIds;
    const next = checked
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((item) => item !== id);
    form.setValue('glossaryIds', next, { shouldDirty: true });
  };

  const restoreDefault = () => {
    form.setValue('glossaryIds', undefined, { shouldDirty: true });
  };

  const selectedGlossaries = isExplicit
    ? glossaries.filter((glossary) => selectedIds.includes(glossary.id))
    : [];

  const stateLabel = !isExplicit
    ? t('configBar.glossaryAllEnabled')
    : selectedGlossaries.length === 0
      ? t('configBar.glossaryNone')
      : selectedGlossaries.length === 1
        ? selectedGlossaries[0].name
        : t('configBar.glossaryCount', { count: selectedGlossaries.length });

  // 还没有词库：只留一个去建词库的入口；“还没有词库”的说明放在 title，不占横向空间
  if (!loading && glossaries.length === 0) {
    return (
      <Button
        asChild
        variant="outline"
        size="sm"
        className="h-8 w-full min-w-0 justify-between gap-1 px-2.5 text-xs font-normal"
      >
        <Link
          href={`/${locale}/glossary`}
          title={t('configBar.glossaryEmpty')}
          aria-label={`${t('configBar.glossary')}: ${t('configBar.glossaryEmpty')}`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <BookOpenText className="h-3.5 w-3.5 flex-none" />
            <span className="truncate">{t('configBar.glossaryGoManage')}</span>
          </span>
        </Link>
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          title={stateLabel}
          aria-label={`${t('configBar.glossary')}: ${stateLabel}`}
          className={cn(
            'h-8 w-full min-w-0 justify-between gap-1 px-2.5 text-xs font-normal',
            isExplicit &&
              'border-primary/50 bg-primary/[0.06] text-primary hover:text-primary',
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <BookOpenText className="h-3.5 w-3.5 flex-none" />
            <span className="truncate">{stateLabel}</span>
          </span>
          <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="w-[280px] max-h-[min(420px,calc(var(--radix-popover-content-available-height)-8px))] overflow-y-auto space-y-2"
      >
        <div>
          <p className="text-sm font-medium">{t('configBar.glossary')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('configBar.glossaryIntro')}
          </p>
        </div>

        {isExplicit && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={restoreDefault}
          >
            {t('configBar.glossaryRestoreDefault')}
          </button>
        )}

        <div className="space-y-0.5">
          {glossaries.map((glossary) => {
            const inputId = `${idBase}-${glossary.id}`;
            // 复选框自带一层 <label>（包住隐藏的 input），不能再把整行包进 <label>，
            // 否则是嵌套 label。改用 htmlFor 把名称关联到同一个 input：
            // 点名称即可切换，同时让复选框拥有可访问名称。
            return (
              <div
                key={glossary.id}
                className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/60"
              >
                <Checkbox
                  id={inputId}
                  checked={isChecked(glossary.id)}
                  onCheckedChange={(checked) =>
                    toggle(glossary.id, checked === true)
                  }
                />
                <label
                  htmlFor={inputId}
                  title={glossary.name}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                >
                  <span className="truncate text-sm">{glossary.name}</span>
                  {glossary.enabled === false && (
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {t('configBar.glossaryDisabled')}
                    </span>
                  )}
                </label>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default GlossarySelectControl;
