import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Sparkles,
  Minimize2,
  ChevronDown,
  Loader2,
  Settings2,
  CircleStop,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import InlineAiSettings from './InlineAiSettings';
import type { InlineAiControl } from '../../hooks/useInlineAi';
import type { AiIntent } from '../../lib/inlineAi';

export default function InlineAiToolbar({
  control,
  currentIndex,
  count,
  compact = false,
}: {
  control: InlineAiControl;
  currentIndex: number;
  count: number;
  compact?: boolean;
}) {
  const { t } = useTranslation('home');
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const run = (all: boolean, action: AiIntent) => {
    setOpen(false);
    void control.run(
      all ? Array.from({ length: count }, (_, i) => i) : [currentIndex],
      action,
    );
  };
  return (
    <div className="flex min-w-0 items-center gap-1" data-ai-toolbar>
      <Popover
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setSettings(false);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            aria-label={
              compact ? t('inlineAi.settings') : t('editorToolbar.aiAssistant')
            }
            onClick={() => void control.loadProviders()}
          >
            {control.running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 text-primary" />
            )}
            {compact
              ? t('editorToolbar.aiSettings')
              : t('editorToolbar.aiAssistant')}
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className={`${settings || compact ? 'w-[380px]' : 'w-[340px]'} max-w-[calc(100vw-32px)] max-h-[min(720px,calc(100vh-100px))] overflow-y-auto p-3`}
          aria-label={
            settings || compact
              ? t('inlineAi.settings')
              : t('editorToolbar.aiAssistant')
          }
        >
          {!settings && !compact ? (
            <div className="space-y-3" data-ai-actions>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('editorToolbar.aiHint')}
              </p>
              {[false, true].map((all) => (
                <div key={String(all)} className="space-y-1">
                  <p className="px-2 text-xs font-medium text-muted-foreground">
                    {all
                      ? t('editorToolbar.allCues', { count })
                      : currentIndex >= 0 && currentIndex < count
                        ? t('editorToolbar.currentCue', {
                            number: currentIndex + 1,
                          })
                        : t('editorToolbar.selectCue')}
                  </p>
                  <div className="flex gap-1 rounded-md bg-muted/50 p-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1 justify-start gap-2"
                      aria-label={all ? t('batchAiOptimize') : t('aiOptimize')}
                      disabled={
                        control.running ||
                        (all
                          ? !count
                          : currentIndex < 0 || currentIndex >= count)
                      }
                      onClick={() => run(all, 'polish')}
                    >
                      <Sparkles className="h-4 w-4" />
                      {t('editorToolbar.polish')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1 justify-start gap-2"
                      aria-label={
                        all ? t('inlineAi.batchShorten') : t('inlineAi.shorten')
                      }
                      disabled={
                        control.running ||
                        (all
                          ? !count
                          : currentIndex < 0 || currentIndex >= count)
                      }
                      onClick={() => run(all, 'shorten')}
                    >
                      <Minimize2 className="h-4 w-4" />
                      {t('editorToolbar.shorten')}
                    </Button>
                  </div>
                </div>
              ))}
              <div className="border-t pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={() => setSettings(true)}
                >
                  <Settings2 className="h-4 w-4" />
                  {t('inlineAi.settings')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{t('inlineAi.settings')}</p>
              </div>
              <InlineAiSettings control={control} />
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  if (compact) setOpen(false);
                  else setSettings(false);
                }}
              >
                {compact ? t('aiSettings.done') : t('editorToolbar.backToAi')}
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {control.running && (
        <>
          <span role="status" className="text-xs tabular-nums">
            {t('optimizing')} {control.progress}%
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t('cancel')}
            title={t('cancel')}
            onClick={control.cancel}
          >
            <CircleStop className="h-4 w-4" />
          </Button>
        </>
      )}
      {control.error && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 text-destructive">
              {t('aiOptimizeFailed')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="max-w-[calc(100vw-32px)]">
            <div role="alert" className="space-y-2 text-xs">
              <p className="break-words text-destructive">{control.error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void control.loadProviders()}
              >
                {t('waveform.retry')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
