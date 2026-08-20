import React from 'react';
import { useTranslation } from 'next-i18next';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import type { Provider } from '../../types/provider';
import { isProviderConfigured } from '../lib/providerUtils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ProviderFallbackEditorProps = {
  provider: Provider;
  providers: Provider[];
  onChange: (ids: string[]) => void;
  onSelectProvider: (id: string) => void;
  onAddFallback: () => void;
};

export default function ProviderFallbackEditor({
  provider,
  providers,
  onChange,
  onSelectProvider,
  onAddFallback,
}: ProviderFallbackEditorProps) {
  const { t } = useTranslation('translateControl');
  const byId = new Map(providers.map((candidate) => [candidate.id, candidate]));
  const chain = (provider.fallbackProviderIds ?? [])
    .map((id) => byId.get(id))
    .filter(
      (candidate): candidate is Provider =>
        !!candidate && candidate.type === provider.type,
    );
  const chainIds = chain.map((candidate) => candidate.id);
  const available = providers.filter(
    (candidate) =>
      candidate.id !== provider.id &&
      candidate.type === provider.type &&
      !chainIds.includes(candidate.id),
  );

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= chainIds.length) return;
    const next = [...chainIds];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const remove = (id: string) =>
    onChange(chainIds.filter((item) => item !== id));

  return (
    <section className="mt-5 space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t('fallbackProviders')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('fallbackProvidersTips')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onAddFallback}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('addFallbackProvider')}
        </Button>
      </div>

      {chain.length > 0 ? (
        <div className="space-y-1.5">
          {chain.map((candidate, index) => (
            <div
              key={candidate.id}
              className="flex min-h-10 items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                {index + 1}
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={candidate.name}
                onClick={() => onSelectProvider(candidate.id)}
              >
                {candidate.name}
              </button>
              <Badge
                variant="outline"
                className={
                  isProviderConfigured(candidate)
                    ? 'shrink-0 border-success/40 text-success'
                    : 'shrink-0 text-muted-foreground'
                }
              >
                {isProviderConfigured(candidate)
                  ? t('configured')
                  : t('fallbackNeedsConfig')}
              </Badge>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={t('chainMoveUp')}
                  title={t('chainMoveUp')}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={index === chain.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={t('chainMoveDown')}
                  title={t('chainMoveDown')}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => remove(candidate.id)}
                  aria-label={t('chainRemove')}
                  title={t('chainRemove')}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {t('fallbackProvidersEmpty')}
        </p>
      )}

      {available.length > 0 && (
        <Select value="" onValueChange={(id) => onChange([...chainIds, id])}>
          <SelectTrigger className="h-9">
            <SelectValue placeholder={t('addExistingFallbackProvider')} />
          </SelectTrigger>
          <SelectContent>
            {available.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  );
}
