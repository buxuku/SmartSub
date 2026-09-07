import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Play } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { MissedSpeechWarning } from '../../../types/missedSpeech';

type Translate = (key: string, options?: any) => string;

export function speechRangeTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 3600)
    .toString()
    .padStart(2, '0')}:${Math.floor((total / 60) % 60)
    .toString()
    .padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}.${Math.round(
    ms % 1000,
  )
    .toString()
    .padStart(3, '0')}`;
}

export function missedSpeechDescription(
  warning: MissedSpeechWarning,
  t: Translate,
): string {
  return `${t('missedSpeech.title')} (${t(`missedSpeech.level.${warning.level}`)})\n${speechRangeTime(warning.startMs)} - ${speechRangeTime(warning.endMs)}\n${warning.signals.map((signal) => t(`missedSpeech.signal.${signal}`)).join(', ')}\n${t('missedSpeech.caution')}`;
}

export default function MissedSpeechControls({
  warnings,
  onSeek,
}: {
  warnings: MissedSpeechWarning[];
  onSeek?: (startMs: number) => void;
}) {
  const { t } = useTranslation('home');
  const [selectedId, setSelectedId] = useState('');
  useEffect(() => {
    if (!warnings.some((warning) => warning.id === selectedId)) {
      setSelectedId(warnings[0]?.id || '');
    }
  }, [warnings, selectedId]);
  if (!warnings.length) return null;
  const index = Math.max(
    0,
    warnings.findIndex((warning) => warning.id === selectedId),
  );
  const active = warnings[index];
  const select = (i: number) => {
    const warning = warnings[(i + warnings.length) % warnings.length];
    setSelectedId(warning.id);
    onSeek?.(warning.startMs);
  };
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs text-warning"
      data-testid="missed-speech-controls"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{t('missedSpeech.count', { count: warnings.length })}</span>
      <label className="min-w-0 max-w-full flex-1">
        <span className="sr-only">{t('missedSpeech.range')}</span>
        <select
          className="h-8 w-full min-w-0 rounded border bg-background px-1 text-xs text-foreground"
          value={active.id}
          onChange={(event) =>
            select(
              warnings.findIndex(
                (warning) => warning.id === event.target.value,
              ),
            )
          }
        >
          {warnings.map((warning) => (
            <option key={warning.id} value={warning.id}>
              {speechRangeTime(warning.startMs)} -{' '}
              {speechRangeTime(warning.endMs)} (
              {t(`missedSpeech.level.${warning.level}`)})
            </option>
          ))}
        </select>
      </label>
      <TooltipProvider>
        <div className="flex items-center gap-1">
          {[
            {
              name: 'previous',
              icon: ChevronUp,
              action: () => select(index - 1),
              disabled: warnings.length < 2,
            },
            {
              name: 'next',
              icon: ChevronDown,
              action: () => select(index + 1),
              disabled: warnings.length < 2,
            },
            {
              name: 'listen',
              icon: Play,
              action: () => onSeek?.(active.startMs),
              disabled: !onSeek,
            },
          ].map(({ name, icon: Icon, action, disabled }) => (
            <Tooltip key={name}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={t(`missedSpeech.${name}`)}
                  onClick={action}
                  disabled={disabled}
                >
                  <Icon className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t(`missedSpeech.${name}`)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
      <span className="w-full break-words text-muted-foreground">
        {active.signals
          .map((signal) => t(`missedSpeech.signal.${signal}`))
          .join(', ')}
        . {t('missedSpeech.caution')}
      </span>
    </div>
  );
}
