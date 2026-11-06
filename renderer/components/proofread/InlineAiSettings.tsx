import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { isProviderConfigured } from 'lib/providerUtils';
import type { InlineAiControl } from '../../hooks/useInlineAi';
import type { AiIntent, InlineAiSuggestion } from '../../lib/inlineAi';

export default function InlineAiSettings({
  control,
}: {
  control: InlineAiControl;
}) {
  const { t } = useTranslation('home');
  const [advanced, setAdvanced] = useState(false);
  // This selects a template to edit, independently of the next AI action.
  const [template, setTemplate] = useState(
    `${control.promptField}:single:polish`,
  );
  const fields: InlineAiSuggestion['field'][] =
    control.defaultField === 'targetContent'
      ? ['targetContent', 'sourceContent']
      : ['sourceContent'];
  const [selectedField, scope, operation] = template.split(':');
  const field: InlineAiSuggestion['field'] = fields.includes(
    selectedField as InlineAiSuggestion['field'],
  )
    ? (selectedField as InlineAiSuggestion['field'])
    : control.defaultField === 'targetContent'
      ? 'targetContent'
      : 'sourceContent';
  const batch = scope === 'batch';
  const intent = operation as AiIntent;
  const templateName = (
    target: InlineAiSuggestion['field'],
    all: boolean,
    action: AiIntent,
  ) =>
    t('aiSettings.templateName', {
      field: t(
        target === 'sourceContent'
          ? 'quality.originalField'
          : 'quality.translationField',
      ),
      scope: t(all ? 'aiSettings.batch' : 'aiSettings.single'),
      operation: t(
        action === 'polish' ? 'editorToolbar.polish' : 'editorToolbar.shorten',
      ),
    });
  return (
    <div className="space-y-4" data-ai-settings>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('aiSettings.intro')}
      </p>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('selectAiProvider')}</p>
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('aiSettings.providerHelp')}
        </p>
        {!control.providers.some(isProviderConfigured) && (
          <p className="text-xs text-warning">{t('aiSettings.noProvider')}</p>
        )}
      </div>
      <Collapsible
        open={advanced}
        onOpenChange={setAdvanced}
        className="border-t pt-3"
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-between px-1"
          >
            {t('aiSettings.advanced')}
            <ChevronDown
              className={`h-4 w-4 transition-transform ${advanced ? 'rotate-180' : ''}`}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <p className="text-sm font-medium">{t('aiSettings.promptTitle')}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('aiSettings.promptHelp')}
            </p>
            <label className="block space-y-1.5 text-xs">
              <span>{t('aiSettings.template')}</span>
              <select
                aria-label={t('aiSettings.template')}
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                value={`${field}:${scope}:${operation}`}
                onChange={(event) => setTemplate(event.target.value)}
              >
                {fields.map((target) => (
                  <optgroup
                    key={target}
                    label={t(
                      target === 'sourceContent'
                        ? 'quality.originalField'
                        : 'quality.translationField',
                    )}
                  >
                    {[false, true].flatMap((all) =>
                      (['polish', 'shorten'] as const).map((action) => (
                        <option
                          key={`${target}:${all}:${action}`}
                          value={`${target}:${all ? 'batch' : 'single'}:${action}`}
                        >
                          {templateName(target, all, action)}
                        </option>
                      )),
                    )}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-xs">
              <span>{t('aiSettings.promptContent')}</span>
              <Textarea
                aria-label={t('aiSettings.promptContent')}
                className="h-36 resize-y text-xs leading-relaxed"
                value={control.getPrompt(batch, intent, field)}
                onChange={(event) =>
                  control.changePrompt(batch, intent, event.target.value, field)
                }
              />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('aiSettings.promptSaved')}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-1 text-xs"
              onClick={() => control.resetPrompt(batch, intent, field)}
            >
              <RotateCcw className="h-3 w-3" />
              {t('aiSettings.resetTemplate')}
            </Button>
          </div>
          <div className="space-y-2">
            <label className="flex items-center justify-between gap-3 text-xs">
              <span>{t('aiSettings.batchSize')}</span>
              <Input
                aria-label={t('aiSettings.batchSize')}
                className="h-8 w-20"
                type="number"
                min={1}
                max={50}
                value={control.batchSize}
                onChange={(event) =>
                  control.setBatchSize(
                    Math.max(
                      1,
                      Math.min(50, Math.floor(Number(event.target.value)) || 1),
                    ),
                  )
                }
              />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('aiSettings.batchHelp')}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
        {t('aiSettings.applyHelp')}
      </p>
    </div>
  );
}
