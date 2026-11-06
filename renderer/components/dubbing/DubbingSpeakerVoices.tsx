import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  RotateCcw,
  Volume2,
  ListMusic,
  Square,
} from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import VoiceLibrary from './VoiceLibrary';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import {
  DUBBING_GLOBAL_VOICE_ID,
  primaryDubbingSpeakerId,
} from '../../../types/dubbing';

function SpeakerNumber({
  value,
  min,
  max,
  step,
  label,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  disabled: boolean;
  onCommit: (value: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(String(value));
  const pending = useRef(false);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = async () => {
    if (pending.current || disabled) return;
    const number = Number(draft);
    if (
      !draft.trim() ||
      !Number.isFinite(number) ||
      number < min ||
      number > max
    ) {
      setDraft(String(value));
      return;
    }
    if (number === value) return;
    pending.current = true;
    try {
      if (!(await onCommit(number))) setDraft(String(value));
    } finally {
      pending.current = false;
    }
  };
  return (
    <label className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <Input
        type="number"
        aria-label={label}
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="h-7 min-w-0 px-1 text-xs tabular-nums"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
      />
    </label>
  );
}

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
  const disabled =
    running || exporting || dub.speakerUpdating || dub.configBlocked;
  const voiceIds = new Set(
    (activeEngine?.voices || []).map((voice) => voice.id),
  );
  const firstMissingRef = useRef<HTMLButtonElement | null>(null);
  const firstMissingId = missingSpeakerVoiceIds[0];
  const [auditioning, setAuditioning] = useState(false);
  const auditionRevision = useRef(0);
  useEffect(() => {
    setAuditioning(false);
    return () => {
      auditionRevision.current++;
      dub.stopPreview();
    };
  }, [dub.session?.sessionId, activeEngine?.key]);
  const auditionCast = async () => {
    const revision = ++auditionRevision.current;
    if (auditioning) {
      dub.stopPreview();
      setAuditioning(false);
      return;
    }
    setAuditioning(true);
    try {
      for (const speaker of speakers) {
        if (revision !== auditionRevision.current) break;
        const selected = speakerVoiceMap[String(speaker.id)];
        const voiceId =
          selected === DUBBING_GLOBAL_VOICE_ID || !selected
            ? activeVoice
            : selected;
        if (!voiceId || !voiceIds.has(voiceId)) continue;
        if (!(await previewVoice(voiceId, undefined, speaker.id))) break;
      }
    } finally {
      if (revision === auditionRevision.current) setAuditioning(false);
    }
  };

  useEffect(() => {
    if (!firstMissingId || disabled) return;
    const frame = requestAnimationFrame(() => {
      firstMissingRef.current?.scrollIntoView({ block: 'nearest' });
      firstMissingRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [firstMissingId, disabled, activeEngine?.key]);

  return (
    <section
      aria-label={t('speakerVoicesTitle')}
      className="min-w-0 shrink-0 bg-muted/40 px-2 py-2"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{t('speakerVoicesTitle')}</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 text-xs"
          disabled={
            disabled ||
            !activeVoice ||
            missingSpeakerVoiceIds.length > 0 ||
            dub.conflictingSpeakerIds?.length > 0
          }
          onClick={() => void auditionCast()}
        >
          {auditioning ? (
            <Square className="h-3 w-3" />
          ) : (
            <ListMusic className="h-3 w-3" />
          )}
          {auditioning ? t('stopPreview') : t('previewCast')}
        </Button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {speakers.map((speaker) => {
          const settings = dub.speakerSettings[String(speaker.id)] || {
            speed: 1,
            pitch: 0,
          };
          const selected = speakerVoiceMap[String(speaker.id)];
          const selectedAvailable =
            selected === DUBBING_GLOBAL_VOICE_ID ||
            Boolean(selected && voiceIds.has(selected));
          const missing = missingSpeakerVoiceIds.includes(speaker.id);
          const conflicts = speakerVoiceConflicts[String(speaker.id)] || [];
          const settingsConflicts =
            dub.speakerSettingsConflicts?.[String(speaker.id)] || [];
          const representative = cues.find(
            (cue) =>
              primaryDubbingSpeakerId(cue) === speaker.id && cue.text.trim(),
          );
          const staleCount = cues.filter(
            (cue) =>
              cue.needsUpdate && primaryDubbingSpeakerId(cue) === speaker.id,
          ).length;
          const previewVoiceId =
            selected === DUBBING_GLOBAL_VOICE_ID ? activeVoice : selected;
          return (
            <div
              key={speaker.id}
              data-speaker-card={speaker.id}
              className="w-[272px] shrink-0 space-y-2 rounded-md bg-card p-2.5"
            >
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
                <VoiceLibrary
                  dub={dub}
                  speakerId={speaker.id}
                  value={selectedAvailable ? selected : ''}
                  onSelect={(voiceId) => setSpeakerVoice(speaker.id, voiceId)}
                  disabled={disabled || !activeEngine}
                  ref={
                    speaker.id === firstMissingId ? firstMissingRef : undefined
                  }
                  className="h-8 min-w-0 flex-1 text-xs"
                  label={t('speakerVoiceFor', { name: speaker.name })}
                  placeholder={
                    selected && !selectedAvailable
                      ? t('voiceUnavailable')
                      : t('speakerVoicePlaceholder')
                  }
                  fallback={{
                    id: DUBBING_GLOBAL_VOICE_ID,
                    label: t('speakerUseGlobal'),
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title={t('previewSpeakerVoice', { name: speaker.name })}
                  aria-label={t('previewSpeakerVoice', { name: speaker.name })}
                  disabled={disabled || !previewVoiceId || !selectedAvailable}
                  onClick={() => {
                    auditionRevision.current++;
                    setAuditioning(false);
                    if (previewing) dub.stopPreview();
                    else
                      void previewVoice(previewVoiceId, undefined, speaker.id);
                  }}
                >
                  {previewing && dub.previewLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : previewing ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <SpeakerNumber
                  value={settings.speed}
                  min={0.5}
                  max={2}
                  step={0.05}
                  label={t('speakerSpeed')}
                  disabled={disabled}
                  onCommit={(speed) =>
                    dub.setSpeakerSettings(speaker.id, { ...settings, speed })
                  }
                />
                <SpeakerNumber
                  value={settings.pitch}
                  min={-12}
                  max={12}
                  step={1}
                  label={t('speakerPitch')}
                  disabled={disabled}
                  onCommit={(pitch) =>
                    dub.setSpeakerSettings(speaker.id, { ...settings, pitch })
                  }
                />
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
              {settingsConflicts.length > 1 && (
                <div role="alert" className="space-y-1 text-xs text-warning">
                  <p>{t('speakerSettingsConflict')}</p>
                  <div className="flex flex-wrap gap-1">
                    {settingsConflicts.map((choice) => (
                      <Button
                        key={`${choice.speed}:${choice.pitch}`}
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={disabled}
                        onClick={() =>
                          dub.setSpeakerSettings(speaker.id, choice)
                        }
                      >
                        {t('speakerSettingsChoice', {
                          speed: choice.speed,
                          pitch: choice.pitch,
                        })}
                      </Button>
                    ))}
                  </div>
                </div>
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
    </section>
  );
}
