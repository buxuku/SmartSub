/**
 * 「翻译」页下段：产品级通读摘要提示词。
 * 不属于任何服务商折叠项；空值回落出厂稿，「恢复出厂」清空 settings 键。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { RotateCcw } from 'lucide-react';
import { Panel, PanelHeader } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  createDebouncedPersist,
  type DebouncedPersist,
} from '@/lib/debouncedPersist';
import { defaultSummaryPrompt, resolveSummaryPrompt } from '../../../types';

const SAVE_DEBOUNCE_MS = 400;

const SummaryPromptPanel: React.FC = () => {
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
    <Panel className="flex-none">
      <PanelHeader
        title={t('summaryPrompt.title')}
        meta={t('summaryPrompt.meta')}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={handleRestore}
            disabled={!loaded || isFactory}
          >
            <RotateCcw className="h-3 w-3" />
            {t('summaryPrompt.restore')}
          </Button>
        }
      />
      <div className="flex flex-col gap-1.5 p-2.5">
        <Textarea
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          disabled={!loaded}
          spellCheck={false}
          className="min-h-[120px] max-h-[220px] resize-y font-mono text-[12px] leading-relaxed"
          aria-label={t('summaryPrompt.title')}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t('summaryPrompt.tips')}
        </p>
      </div>
    </Panel>
  );
};

export default SummaryPromptPanel;
