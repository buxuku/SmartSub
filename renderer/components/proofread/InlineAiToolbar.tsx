import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Sparkles,
  Minimize2,
  Wand2,
  Settings2,
  CircleStop,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
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
import { isProviderConfigured } from 'lib/providerUtils';
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
  const [batch, setBatch] = useState(false);
  const [intent, setIntent] = useState<AiIntent>('polish');
  return (
    <div
      className="flex flex-wrap items-center gap-1 bg-muted/20 px-2 py-1"
      data-ai-toolbar
    >
      {!compact && (
        <>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1"
            disabled={currentIndex < 0 || control.running}
            onClick={() => void control.run([currentIndex])}
          >
            <Sparkles className="h-4 w-4" />
            {t('aiOptimize')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1"
            disabled={currentIndex < 0 || control.running}
            onClick={() => void control.run([currentIndex], 'shorten')}
          >
            <Minimize2 className="h-4 w-4" />
            {t('inlineAi.shorten')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1"
            disabled={!count || control.running}
            onClick={() =>
              void control.run(Array.from({ length: count }, (_, i) => i))
            }
          >
            <Wand2 className="h-4 w-4" />
            {t('batchAiOptimize')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1"
            disabled={!count || control.running}
            onClick={() =>
              void control.run(
                Array.from({ length: count }, (_, i) => i),
                'shorten',
              )
            }
          >
            <Minimize2 className="h-4 w-4" />
            {t('inlineAi.batchShorten')}
          </Button>
        </>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={t('inlineAi.settings')}
            title={t('inlineAi.settings')}
            onClick={() => void control.loadProviders()}
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[360px] max-w-[calc(100vw-32px)] space-y-3"
          align="start"
        >
          <label className="block space-y-1 text-xs">
            {t('inlineAi.promptField')}
            <select
              aria-label={t('inlineAi.promptField')}
              className="h-8 w-full rounded border bg-background px-2"
              value={control.promptField}
              onChange={(e) =>
                control.setPromptField(
                  e.target.value as 'sourceContent' | 'targetContent',
                )
              }
            >
              <option value="sourceContent">
                {t('quality.originalField')}
              </option>
              {control.defaultField === 'targetContent' && (
                <option value="targetContent">
                  {t('quality.translationField')}
                </option>
              )}
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            {t('selectAiProvider')}
            <Select
              value={control.providerId}
              onValueChange={control.setProviderId}
            >
              <SelectTrigger aria-label={t('selectAiProvider')}>
                <SelectValue placeholder={t('selectProvider')} />
              </SelectTrigger>
              <SelectContent>
                {control.providers.map((provider) => (
                  <SelectItem
                    key={provider.id}
                    value={provider.id}
                    disabled={!isProviderConfigured(provider)}
                  >
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="block space-y-1 text-xs">
            {t('inlineAi.scope')}
            <Select
              value={batch ? 'batch' : 'single'}
              onValueChange={(value) => setBatch(value === 'batch')}
            >
              <SelectTrigger aria-label={t('inlineAi.scope')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">{t('inlineAi.single')}</SelectItem>
                <SelectItem value="batch">{t('batchAiOptimize')}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="block space-y-1 text-xs">
            {t('inlineAi.operation')}
            <Select
              value={intent}
              onValueChange={(value: AiIntent) => setIntent(value)}
            >
              <SelectTrigger aria-label={t('inlineAi.operation')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="polish">{t('aiOptimize')}</SelectItem>
                <SelectItem value="shorten">{t('inlineAi.shorten')}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {batch && (
            <label className="block space-y-1 text-xs">
              {t('inlineAi.batchSize')}
              <Input
                aria-label={t('inlineAi.batchSize')}
                type="number"
                min={1}
                max={50}
                value={control.batchSize}
                onChange={(e) =>
                  control.setBatchSize(
                    Math.max(
                      1,
                      Math.min(50, Math.floor(Number(e.target.value)) || 1),
                    ),
                  )
                }
              />
            </label>
          )}
          <label className="block space-y-1 text-xs">
            {t('customPrompt')}
            <Textarea
              aria-label={t('customPrompt')}
              className="h-36 resize-y"
              value={control.getPrompt(batch, intent, control.promptField)}
              onChange={(e) =>
                control.changePrompt(
                  batch,
                  intent,
                  e.target.value,
                  control.promptField,
                )
              }
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              control.resetPrompt(batch, intent, control.promptField)
            }
            className="gap-1"
          >
            <RotateCcw className="h-3 w-3" />
            {t('resetToDefault')}
          </Button>
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
        <div role="alert" className="w-full text-xs text-destructive">
          <details open>
            <summary>{t('aiOptimizeFailed')}</summary>
            <p className="break-words">{control.error}</p>
          </details>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void control.loadProviders()}
          >
            {t('waveform.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
