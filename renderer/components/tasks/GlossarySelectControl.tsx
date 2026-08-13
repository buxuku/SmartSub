/**
 * 任务配置条的词库多选。未交互时 formData.glossaryIds 保持 undefined
 * （回落全部已启用）；勾选后写入显式 id 数组，取消最后一项得到 []。
 */
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { BookOpenText } from 'lucide-react';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import { useGlossaries } from 'hooks/useGlossaries';

interface GlossarySelectControlProps {
  form: any;
  formData: any;
}

const GlossarySelectControl: React.FC<GlossarySelectControlProps> = ({
  form,
  formData,
}) => {
  const { t } = useTranslation('tasks');
  const router = useRouter();
  const { locale } = router.query;
  const [open, setOpen] = useState(false);
  const { glossaries, loading } = useGlossaries();

  const setValue = (name: string, value: unknown) =>
    form.setValue(name, value, { shouldDirty: true });

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
    setValue('glossaryIds', next);
  };

  const restoreDefault = () => {
    setValue('glossaryIds', undefined);
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

  if (!loading && glossaries.length === 0) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t('configBar.glossary')}
        </span>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1.5"
        >
          <Link href={`/${locale}/glossary`}>
            <BookOpenText className="h-3.5 w-3.5" />
            {t('configBar.glossaryGoManage')}
          </Link>
        </Button>
        <span className="text-xs text-muted-foreground">
          {t('configBar.glossaryEmpty')}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {t('configBar.glossary')}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 text-xs',
              isExplicit &&
                'border-primary/50 bg-primary/[0.06] text-primary hover:text-primary',
            )}
          >
            <BookOpenText className="h-3.5 w-3.5" />
            {stateLabel}
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

          <div className="space-y-1">
            {glossaries.map((glossary) => (
              <div key={glossary.id} className="flex items-center gap-2 py-1">
                <Checkbox
                  checked={isChecked(glossary.id)}
                  onCheckedChange={(checked) =>
                    toggle(glossary.id, checked === true)
                  }
                />
                <span className="text-sm truncate">{glossary.name}</span>
                {glossary.enabled === false && (
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {t('configBar.glossaryDisabled')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default GlossarySelectControl;
