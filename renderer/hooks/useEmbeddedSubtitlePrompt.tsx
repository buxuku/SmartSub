import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Captions } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import {
  describeEmbeddedTrack,
  embeddedSubtitleFileName,
} from '../lib/embeddedSubtitleScan';
import type { EmbeddedSubtitleHit } from '../../types/embeddedSubtitle';

/** `use` / `asr` apply to the one task being started; `cancel` stops the start. */
export type EmbeddedSubtitleChoice = 'use' | 'asr' | 'cancel';

/** Tracks named in the sentence; the rest is summarised as a count. */
const VISIBLE_TRACKS = 3;

/**
 * "Remember my choice": the choice becomes the default of the next new task and the
 * prompt is switched off. The default goes first, so a choice that cannot be stored
 * leaves the prompt on instead of silently going quiet. Best effort like the cloud
 * upload consent: a failed write never blocks the task being started.
 */
async function rememberChoice(useEmbeddedSubtitles: boolean) {
  try {
    await window.ipc.invoke('updateTaskDefaults', { useEmbeddedSubtitles });
    await window.ipc.invoke('setSettings', { embeddedSubtitlePrompt: false });
  } catch {
    /* The choice still applies to this task. */
  }
}

/**
 * Asks, before a start, whether to use the subtitles a video already carries or to
 * transcribe it. Shared by every start entry point through `useTaskSubmission`.
 */
export function useEmbeddedSubtitlePrompt() {
  const { t, i18n } = useTranslation(['home', 'common']);
  const [hit, setHit] = useState<EmbeddedSubtitleHit | null>(null);
  const [remember, setRemember] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const mounted = useRef(false);
  const decidingRef = useRef(false);
  const pending = useRef<((choice: EmbeddedSubtitleChoice) => void) | null>(
    null,
  );
  // The dialog animates out after `hit` is cleared and must keep its content meanwhile.
  const shown = useRef<EmbeddedSubtitleHit | null>(null);
  if (hit) shown.current = hit;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.('cancel');
      pending.current = null;
    };
  }, []);

  const finish = useCallback((choice: EmbeddedSubtitleChoice) => {
    pending.current?.(choice);
    pending.current = null;
    decidingRef.current = false;
    setDeciding(false);
    setRemember(false);
    setHit(null);
  }, []);

  const requestChoice = useCallback(
    (next: EmbeddedSubtitleHit): Promise<EmbeddedSubtitleChoice> => {
      if (!mounted.current) return Promise.resolve('cancel');
      pending.current?.('cancel');
      return new Promise<EmbeddedSubtitleChoice>((resolve) => {
        pending.current = resolve;
        decidingRef.current = false;
        setDeciding(false);
        setRemember(false);
        setHit(next);
      });
    },
    [],
  );

  const choose = async (choice: 'use' | 'asr') => {
    if (decidingRef.current) return;
    decidingRef.current = true;
    setDeciding(true);
    if (remember) await rememberChoice(choice === 'use');
    finish(choice);
  };

  const view = shown.current;
  const visible = view?.tracks.slice(0, VISIBLE_TRACKS) ?? [];
  const hidden = (view?.tracks.length ?? 0) - visible.length;
  // `moreTracks` is a suffix carrying its own punctuation (", and 2 more" / "，另有 2 条").
  const tracks =
    visible
      .map((track) =>
        describeEmbeddedTrack(
          track,
          i18n.language,
          t('home:embeddedPrompt.unknownLanguage'),
        ),
      )
      .join(t('home:embeddedPrompt.trackSeparator')) +
    (hidden > 0 ? t('home:embeddedPrompt.moreTracks', { count: hidden }) : '');

  return {
    requestChoice,
    dialog: (
      <AlertDialog
        open={hit !== null}
        onOpenChange={(next) => {
          // Once a choice is being applied it is no longer cancellable.
          if (!next && !decidingRef.current) finish('cancel');
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Captions className="h-5 w-5 text-info" />
              {t('home:embeddedPrompt.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('home:embeddedPrompt.description', {
                name: view ? embeddedSubtitleFileName(view.filePath) : '',
                tracks,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* One panel of two definitions, not two cards: they explain the buttons below and
              must not look like options to click. */}
          <dl className="divide-y rounded-lg border bg-muted/40 text-sm">
            <div className="p-3">
              <dt className="font-medium">
                {t('home:embeddedPrompt.useTitle')}
              </dt>
              <dd className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t('home:embeddedPrompt.useDescription')}
              </dd>
            </div>
            <div className="p-3">
              <dt className="font-medium">
                {t('home:embeddedPrompt.asrTitle')}
              </dt>
              <dd className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t('home:embeddedPrompt.asrDescription')}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {t('home:embeddedPrompt.hint')}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={remember}
              onCheckedChange={setRemember}
              disabled={deciding}
              aria-label={t('home:embeddedPrompt.remember')}
            />
            <span>{t('home:embeddedPrompt.remember')}</span>
          </label>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            <AlertDialogCancel
              disabled={deciding}
              onClick={() => finish('cancel')}
            >
              {t('common:cancel')}
            </AlertDialogCancel>
            <Button
              variant="outline"
              disabled={deciding}
              onClick={() => void choose('asr')}
            >
              {t('home:embeddedPrompt.asrTitle')}
            </Button>
            <Button disabled={deciding} onClick={() => void choose('use')}>
              {t('home:embeddedPrompt.useTitle')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}
