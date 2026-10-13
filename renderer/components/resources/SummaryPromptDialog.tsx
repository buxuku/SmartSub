/**
 * 通读摘要提示词的编辑弹窗：产品级全局稿，不属于任何服务商。
 * 空值回落出厂稿，「恢复出厂」清空 settings 键。
 *
 * 这是低频设置，不常驻任何页面。入口：任务配置条「生成摘要」弹层、
 * 「翻译服务」总览的「更多设置」。编辑自动保存，关闭时 flush 最后一次改动。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Check, RotateCcw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  createDebouncedPersist,
  type DebouncedPersist,
} from '@/lib/debouncedPersist';
import {
  defaultSummaryPrompt,
  resolveSummaryPrompt,
} from '../../../types/summaryPrompt';

const SAVE_DEBOUNCE_MS = 400;

/**
 * 编辑体放在 DialogContent 内：弹窗打开才挂载并读取设置，
 * 关闭（卸载）时 flush，不会在后台常驻或丢失最后一次输入。
 */
const SummaryPromptEditor: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { t } = useTranslation('translateControl');
  const [draft, setDraft] = useState(defaultSummaryPrompt);
  const [loaded, setLoaded] = useState(false);

  const persist = useCallback(async (next: string) => {
    const trimmed = next.trim();
    await window?.ipc?.invoke('setSettings', {
      summaryPrompt: trimmed === defaultSummaryPrompt.trim() ? '' : next,
    });
  }, []);

  const writerRef = useRef<DebouncedPersist<string> | null>(null);
  if (!writerRef.current) {
    writerRef.current = createDebouncedPersist(persist, SAVE_DEBOUNCE_MS);
  }
  const writer = writerRef.current;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await window?.ipc?.invoke('getSettings');
      if (cancelled) return;
      setDraft(resolveSummaryPrompt(settings?.summaryPrompt));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
      writer.flush();
    };
  }, [writer]);

  const handleChange = (value: string) => {
    setDraft(value);
    writer.schedule(value);
  };

  const handleRestore = async () => {
    writer.cancel();
    setDraft(defaultSummaryPrompt);
    await persist(defaultSummaryPrompt);
  };

  const isFactory = draft.trim() === defaultSummaryPrompt.trim();

  return (
    <>
      <DialogHeader className="pr-6">
        <DialogTitle>{t('summaryPrompt.title')}</DialogTitle>
        <DialogDescription>{t('summaryPrompt.meta')}</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-1.5">
        {/* readOnly 而非 disabled：弹窗打开时 Radix 要把焦点落到这里，disabled 的框接不住 */}
        <Textarea
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          readOnly={!loaded}
          spellCheck={false}
          className="min-h-[280px] max-h-[50vh] resize-y font-mono text-[12px] leading-relaxed"
          aria-label={t('summaryPrompt.title')}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t('summaryPrompt.tips')}
        </p>
      </div>
      <DialogFooter className="items-center sm:justify-between sm:space-x-0">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={handleRestore}
          disabled={!loaded || isFactory}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('summaryPrompt.restore')}
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {t('summaryPrompt.autosave')}
          </span>
          <Button type="button" size="sm" className="gap-1.5" onClick={onDone}>
            <Check className="h-4 w-4" />
            {t('summaryPrompt.done')}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
};

export interface SummaryPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 关闭后把焦点交还给这个元素。受控弹窗没有 DialogTrigger，Radix 不会自动归还焦点，
   * 焦点会掉到 body，键盘用户就丢了位置；任务配置条里入口所在的弹层还会先于弹窗卸载。
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

const SummaryPromptDialog: React.FC<SummaryPromptDialogProps> = ({
  open,
  onOpenChange,
  returnFocusRef,
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      className="max-w-2xl"
      onCloseAutoFocus={(event) => {
        if (!returnFocusRef) return;
        event.preventDefault();
        returnFocusRef.current?.focus();
      }}
    >
      <SummaryPromptEditor onDone={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>
);

export default SummaryPromptDialog;
