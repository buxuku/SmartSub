import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Loader2, RotateCcw, Volume2 } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import {
  DUBBING_GLOBAL_VOICE_ID,
  primaryDubbingSpeakerId,
} from '../../../types/dubbing';

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export default function DubbingSpeakerVoices({
  dub,
}: {
  dub: UseDubbingReturn;
}) {
  const { t } = useTranslation('dubbing');
  const {
    speakers,
    cues,
    speakerVoiceMap,
    speakerVoiceConflicts,
    missingSpeakerVoiceIds,
    activeEngine,
    activeVoice,
    running,
    exporting,
    previewing,
    setSpeakerVoice,
    regenerateSpeaker,
    previewVoice,
  } = dub;
  const disabled = running || exporting;
  const voiceIds = new Set(
    (activeEngine?.voices || []).map((voice) => voice.id),
  );
  const firstMissingRef = useRef<HTMLButtonElement | null>(null);
  const firstMissingId = missingSpeakerVoiceIds[0];

  useEffect(() => {
    if (!firstMissingId || disabled) return;
    const frame = requestAnimationFrame(() => {
      firstMissingRef.current?.scrollIntoView({ block: 'nearest' });
      firstMissingRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [firstMissingId, disabled, activeEngine?.key]);

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{t('speakerVoicesTitle')}</p>
        <p className="text-xs text-muted-foreground">
          {t('speakerVoicesDesc')}
        </p>
      </div>
      {speakers.map((speaker) => {
        const selected = speakerVoiceMap[String(speaker.id)];
        const selectedAvailable =
          selected === DUBBING_GLOBAL_VOICE_ID ||
          Boolean(selected && voiceIds.has(selected));
        const missing = missingSpeakerVoiceIds.includes(speaker.id);
        const conflicts = speakerVoiceConflicts[String(speaker.id)] || [];
        const representative = cues.find(
          (cue) =>
            primaryDubbingSpeakerId(cue) === speaker.id && cue.text.trim(),
        );
        const staleCount = cues.filter(
          (cue) =>
            cue.needsUpdate &&
            !cue.voiceId &&
            primaryDubbingSpeakerId(cue) === speaker.id,
        ).length;
        const previewVoiceId =
          selected === DUBBING_GLOBAL_VOICE_ID ? activeVoice : selected;
        return (
          <div key={speaker.id} className="space-y-2 rounded-md border p-2.5">
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: speaker.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {speaker.name}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t('speakerCueStats', {
                  count: speaker.cueCount,
                  duration: formatDuration(speaker.totalDurationMs),
                })}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Select
                value={selectedAvailable ? selected : ''}
                onValueChange={(voiceId) =>
                  setSpeakerVoice(speaker.id, voiceId)
                }
                disabled={disabled || !activeEngine}
              >
                <SelectTrigger
                  ref={
                    speaker.id === firstMissingId ? firstMissingRef : undefined
                  }
                  className="h-8 min-w-0 flex-1 text-xs"
                  aria-label={t('speakerVoiceFor', { name: speaker.name })}
                >
                  <SelectValue
                    placeholder={
                      selected && !selectedAvailable
                        ? t('voiceUnavailable')
                        : t('speakerVoicePlaceholder')
                    }
                  />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  <SelectItem value={DUBBING_GLOBAL_VOICE_ID}>
                    {t('speakerUseGlobal')}
                  </SelectItem>
                  {(activeEngine?.voices || []).map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                title={t('previewSpeakerVoice', { name: speaker.name })}
                aria-label={t('previewSpeakerVoice', { name: speaker.name })}
                disabled={
                  disabled ||
                  previewing ||
                  !previewVoiceId ||
                  !selectedAvailable
                }
                onClick={() =>
                  previewVoice(previewVoiceId, representative?.text)
                }
              >
                {previewing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            {(missing || conflicts.length > 1) && (
              <p className="flex items-start gap-1 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {conflicts.length > 1
                  ? t('speakerVoiceConflict')
                  : selected && !selectedAvailable
                    ? t('voiceUnavailableHint')
                    : t('speakerVoiceRequired')}
              </p>
            )}
            {staleCount > 0 && (
              <div className="flex items-center justify-between rounded bg-warning/10 px-2 py-1 text-xs text-warning">
                <span>{t('speakerStaleCount', { count: staleCount })}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs text-warning"
                  disabled={disabled || missing}
                  onClick={() => regenerateSpeaker(speaker.id)}
                >
                  <RotateCcw className="h-3 w-3" />
                  {t('regenerateSpeaker')}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
