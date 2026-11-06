import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from 'lib/utils';

interface EmbeddedSubtitleControlProps {
  /** The task-level switch: anything but an explicit `false` uses embedded subtitles. */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  className?: string;
}

/**
 * Whether a video's own text subtitle track replaces speech recognition, plus whether
 * to ask about it before a start. The first is part of the task; the second is an app
 * setting (`embeddedSubtitlePrompt`) that the start-time dialog's "don't ask again"
 * also writes, so this is where the user takes it back.
 */
export default function EmbeddedSubtitleControl({
  enabled,
  onEnabledChange,
  className,
}: EmbeddedSubtitleControlProps) {
  const { t } = useTranslation('tasks');
  const switchId = useId();
  const promptId = useId();
  // `null` until the stored preference has been read; the box stays inert meanwhile.
  const [prompt, setPrompt] = useState<boolean | null>(null);
  const alive = useRef(true);
  const latestChange = useRef(0);

  useEffect(() => {
    alive.current = true;
    (async () => {
      let value = true;
      try {
        const settings = await window.ipc.invoke('getSettings');
        value = settings?.embeddedSubtitlePrompt !== false;
      } catch {
        /* Unreadable settings behave like a fresh install: the prompt is on. */
      }
      if (alive.current) setPrompt(value);
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  const changePrompt = async (next: boolean) => {
    const previous = prompt;
    const change = ++latestChange.current;
    setPrompt(next);
    try {
      const response = await window.ipc.invoke('setSettings', {
        embeddedSubtitlePrompt: next,
      });
      if (response?.success === false) throw new Error(response.error);
    } catch {
      // Show what is actually stored, unless the user has already changed it again.
      if (alive.current && latestChange.current === change) setPrompt(previous);
    }
  };

  return (
    <div className={cn('space-y-2 rounded-lg border p-2', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor={switchId} className="text-sm">
            {t('configBar.embeddedSubtitles')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('embeddedSubtitleSetting.description')}
          </p>
        </div>
        <Switch
          id={switchId}
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
      <div
        className={cn(
          'flex items-start gap-2 border-t pt-2',
          !enabled && 'opacity-60',
        )}
      >
        <Checkbox
          id={promptId}
          checked={prompt !== false}
          disabled={!enabled || prompt === null}
          onCheckedChange={(checked) => void changePrompt(checked)}
          className="mt-0.5"
        />
        <div className="space-y-0.5">
          <Label htmlFor={promptId} className="text-xs">
            {t('embeddedSubtitleSetting.promptLabel')}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {t('embeddedSubtitleSetting.promptDescription')}
          </p>
        </div>
      </div>
    </div>
  );
}
