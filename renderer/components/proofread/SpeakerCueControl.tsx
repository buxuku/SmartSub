import React, { useMemo } from 'react';
import { Crown, UserRoundPlus, Users, X } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { Subtitle } from '../../hooks/useSubtitles';
import {
  normalizePrimarySpeakerId,
  normalizeSpeakerIds,
  type SpeakerInfo,
} from '../../../types/proofreadData';

interface SpeakerCueControlProps {
  subtitle: Subtitle;
  index: number;
  speakers: SpeakerInfo[];
  onChange: (
    index: number,
    speakerIds: number[],
    primarySpeakerId?: number,
  ) => void;
  onCreate: (index: number) => number;
}

export default function SpeakerCueControl({
  subtitle,
  index,
  speakers,
  onChange,
  onCreate,
}: SpeakerCueControlProps) {
  const { t } = useTranslation('home');
  const ids = useMemo(
    () => normalizeSpeakerIds(subtitle.speakerIds),
    [subtitle.speakerIds],
  );
  const primary = normalizePrimarySpeakerId(subtitle.primarySpeakerId, ids);
  const assigned = ids
    .map((id) => speakers.find((speaker) => speaker.id === id))
    .filter((speaker): speaker is SpeakerInfo => Boolean(speaker));

  const toggleSpeaker = (speakerId: number, checked: boolean) => {
    const next = checked
      ? normalizeSpeakerIds([...ids, speakerId])
      : ids.filter((id) => id !== speakerId);
    onChange(
      index,
      next,
      checked
        ? primary || speakerId
        : primary === speakerId
          ? next[0]
          : primary,
    );
  };

  const makePrimary = (speakerId: number) => {
    onChange(index, normalizeSpeakerIds([...ids, speakerId]), speakerId);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('speakers.editCue')}
          onClick={(event) => event.stopPropagation()}
        >
          {assigned.length ? (
            <span className="flex min-w-0 items-center gap-1">
              {assigned.map((speaker) => (
                <span
                  key={speaker.id}
                  className="inline-flex max-w-28 items-center gap-1 truncate rounded-full border px-1.5 py-0.5"
                  style={{ borderColor: speaker.color }}
                  title={speaker.displayName}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: speaker.color }}
                  />
                  <span className="truncate">{speaker.displayName}</span>
                  {speaker.id === primary && ids.length > 1 && (
                    <Crown className="h-2.5 w-2.5 shrink-0" />
                  )}
                </span>
              ))}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-dashed px-1.5 py-0.5 text-muted-foreground">
              <Users className="h-2.5 w-2.5" />
              {t('speakers.unassigned')}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-72 space-y-2 p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <p className="text-sm font-medium">{t('speakers.assignCue')}</p>
          <p className="text-xs text-muted-foreground">
            {t('speakers.primaryHint')}
          </p>
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {speakers.map((speaker) => {
            const checked = ids.includes(speaker.id);
            return (
              <div
                key={speaker.id}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/60"
              >
                <Checkbox
                  checked={checked}
                  aria-label={t('speakers.toggleAssignment', {
                    name: speaker.displayName,
                  })}
                  onCheckedChange={(value) =>
                    toggleSpeaker(speaker.id, value === true)
                  }
                />
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: speaker.color }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {speaker.displayName}
                </span>
                <Button
                  type="button"
                  variant={primary === speaker.id ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7"
                  title={t('speakers.setPrimary')}
                  aria-label={t('speakers.setPrimaryFor', {
                    name: speaker.displayName,
                  })}
                  onClick={() => makePrimary(speaker.id)}
                >
                  <Crown className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex gap-1.5 border-t pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 gap-1 text-xs"
            onClick={() => onChange(index, [])}
          >
            <X className="h-3 w-3" />
            {t('speakers.setUnassigned')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 gap-1 text-xs"
            onClick={() => onCreate(index)}
          >
            <UserRoundPlus className="h-3 w-3" />
            {t('speakers.newSpeaker')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
