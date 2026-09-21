import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Check,
  ChevronsUpDown,
  Loader2,
  Play,
  Search,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import type { DubbingEngineOption } from '../../hooks/useTtsEngineOptions';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import { cn } from 'lib/utils';

type Voice = DubbingEngineOption['voices'][number];
export function filterLibraryVoices(
  voices: Voice[],
  query: string,
  gender: string,
  language: string,
  style: string,
) {
  const search = query.trim().toLocaleLowerCase();
  return voices.filter(
    (voice) =>
      (!search ||
        `${voice.label} ${voice.id}`.toLocaleLowerCase().includes(search)) &&
      (!gender || (voice.gender || 'unknown') === gender) &&
      (!language || (voice.lang?.split('-')[0] || 'unknown') === language) &&
      (!style ||
        (style === 'unknown'
          ? !voice.styles?.length
          : voice.styles?.includes(style))),
  );
}

const VoiceLibrary = React.forwardRef<
  HTMLButtonElement,
  {
    dub: UseDubbingReturn;
    value: string;
    label: string;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    speakerId?: number;
    fallback?: { id: string; label: string };
    onSelect: (id: string) => void | boolean | Promise<void | boolean>;
  }
>(
  (
    {
      dub,
      value,
      label,
      placeholder,
      disabled,
      className,
      speakerId,
      fallback,
      onSelect,
    },
    ref,
  ) => {
    const { t } = useTranslation('dubbing');
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [gender, setGender] = useState('');
    const [language, setLanguage] = useState('');
    const [style, setStyle] = useState('');
    const [saving, setSaving] = useState(false);
    const [selectionError, setSelectionError] = useState<string | null>(null);
    const pending = useRef(false);
    const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
    const hoverId = useRef<string>();
    // The sheet portal mounts after opening; its scroll node must trigger a render.
    const [parent, setParent] = useState<HTMLDivElement | null>(null);
    const listId = useId();
    const voices = dub.activeEngine?.voices || [];
    const options = useMemo(
      () => filterLibraryVoices(voices, query, gender, language, style),
      [voices, query, gender, language, style],
    );
    const languages = Array.from(
      new Set(voices.map((voice) => voice.lang?.split('-')[0]).filter(Boolean)),
    ) as string[];
    const styles = Array.from(
      new Set([
        'news',
        'story',
        'commentary',
        'anime',
        ...voices.flatMap((voice) => voice.styles || []),
      ]),
    );
    const rows = useVirtualizer({
      count: options.length,
      getScrollElement: () => parent,
      enabled: open,
      estimateSize: () => 84,
      overscan: 4,
    });
    const cancelHover = () => {
      clearTimeout(hoverTimer.current);
      hoverId.current = undefined;
      dub.stopPreview();
    };
    useEffect(() => {
      if (open) cancelHover();
      parent?.scrollTo({ top: 0 });
      if (open) return () => cancelHover();
    }, [query, gender, language, style, open, parent]);
    useEffect(
      () => () => {
        clearTimeout(hoverTimer.current);
      },
      [],
    );
    useEffect(() => {
      setOpen(false);
    }, [dub.activeEngine?.key, dub.session?.sessionId]);
    const choose = async (id: string) => {
      if (pending.current || disabled) return;
      cancelHover();
      pending.current = true;
      setSaving(true);
      setSelectionError(null);
      try {
        if ((await onSelect(id)) !== false) setOpen(false);
      } catch (error) {
        setSelectionError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        pending.current = false;
        setSaving(false);
      }
    };
    const selectedLabel =
      value === fallback?.id
        ? fallback.label
        : voices.find((voice) => voice.id === value)?.label;
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (pending.current) return;
          cancelHover();
          setOpen(next);
        }}
      >
        <SheetTrigger asChild>
          <Button
            ref={ref}
            variant="outline"
            role="combobox"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={label}
            disabled={disabled}
            className={cn(
              'min-w-0 justify-between gap-1 font-normal',
              className,
            )}
          >
            <span className="truncate">
              {selectedLabel || placeholder || t('voicePlaceholder')}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </SheetTrigger>
        <SheetContent
          id={listId}
          aria-describedby={undefined}
          className="flex w-full max-w-full flex-col gap-3 p-4 sm:max-w-[520px]"
          onPointerDownOutside={(event) => {
            if (pending.current) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (pending.current) event.preventDefault();
          }}
        >
          <SheetHeader className="pr-7">
            <SheetTitle>{t('voiceLibrary')}</SheetTitle>
            <p className="truncate text-xs text-muted-foreground">{label}</p>
          </SheetHeader>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label={t('voiceSearch')}
              placeholder={t('voiceSearch')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="min-w-0 text-xs text-muted-foreground">
              {t('voiceGender')}
              <select
                aria-label={t('voiceGender')}
                className="mt-1 h-8 w-full rounded border bg-background px-1 text-foreground"
                value={gender}
                onChange={(event) => setGender(event.target.value)}
              >
                <option value="">{t('voiceAll')}</option>
                {['female', 'male', 'child', 'unknown'].map((key) => (
                  <option key={key} value={key}>
                    {t(`voiceGender_${key}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-xs text-muted-foreground">
              {t('voiceLanguage')}
              <select
                aria-label={t('voiceLanguage')}
                className="mt-1 h-8 w-full rounded border bg-background px-1 text-foreground"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option value="">{t('voiceAll')}</option>
                {[...languages.sort(), 'unknown'].map((key) => (
                  <option key={key} value={key}>
                    {key === 'unknown' ? t('voiceUnknown') : key}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-xs text-muted-foreground">
              {t('voiceStyle')}
              <select
                aria-label={t('voiceStyle')}
                className="mt-1 h-8 w-full rounded border bg-background px-1 text-foreground"
                value={style}
                onChange={(event) => setStyle(event.target.value)}
              >
                <option value="">{t('voiceAll')}</option>
                {[...styles, 'unknown'].map((key) => (
                  <option key={key} value={key}>
                    {[
                      'news',
                      'story',
                      'commentary',
                      'anime',
                      'unknown',
                    ].includes(key)
                      ? t(`voiceStyle_${key}`)
                      : key}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(selectionError || dub.actionError) && (
            <p
              role="alert"
              className="max-h-24 overflow-y-auto break-words text-xs text-destructive"
            >
              {selectionError || dub.actionError}
            </p>
          )}
          {fallback && (
            <Button
              variant="outline"
              disabled={disabled || saving}
              onClick={() => void choose(fallback.id)}
              className="justify-start text-xs"
            >
              {value === fallback.id && <Check className="mr-2 h-3.5 w-3.5" />}
              {fallback.label}
            </Button>
          )}
          <p className="text-xs tabular-nums text-muted-foreground">
            {t('voiceCount', { count: options.length })}
          </p>
          <p role="status" className="text-xs text-muted-foreground">
            {t(
              dub.previewLoading ? 'voicePreviewPreparing' : 'voicePreviewHint',
            )}
          </p>
          <div
            ref={setParent}
            className="min-h-0 flex-1 overflow-y-auto"
            role="list"
            aria-label={t('voiceLibrary')}
          >
            {!options.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('voiceEmpty')}
              </p>
            )}
            <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
              {rows.getVirtualItems().map((row) => {
                const voice = options[row.index];
                const playing = dub.previewVoiceId === voice.id;
                return (
                  <div
                    key={voice.id}
                    role="listitem"
                    data-voice-id={voice.id}
                    className="absolute left-0 top-0 flex h-[76px] w-full items-center gap-2 rounded-md bg-muted/40 px-3"
                    style={{ transform: `translateY(${row.start}px)` }}
                    onPointerEnter={() => {
                      clearTimeout(hoverTimer.current);
                      hoverId.current = voice.id;
                      hoverTimer.current = setTimeout(() => {
                        if (
                          !disabled &&
                          !pending.current &&
                          hoverId.current === voice.id
                        )
                          void dub.previewVoice(voice.id, undefined, speakerId);
                      }, 180);
                    }}
                    onPointerLeave={() => {
                      if (hoverId.current === voice.id) cancelHover();
                    }}
                  >
                    <button
                      type="button"
                      aria-label={voice.label}
                      aria-pressed={value === voice.id}
                      disabled={disabled || saving}
                      className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => void choose(voice.id)}
                    >
                      <span className="flex items-center gap-2 text-sm">
                        <span className="truncate">{voice.label}</span>
                        {value === voice.id && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                        )}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                        {[
                          voice.lang,
                          t(`voiceGender_${voice.gender || 'unknown'}`),
                          ...(voice.styles || []).map((key) =>
                            ['news', 'story', 'commentary', 'anime'].includes(
                              key,
                            )
                              ? t(`voiceStyle_${key}`)
                              : key,
                          ),
                        ]
                          .filter(Boolean)
                          .join(' / ')}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={disabled || saving}
                      title={playing ? t('stopPreview') : t('previewVoice')}
                      aria-label={
                        playing ? t('stopPreview') : t('previewVoice')
                      }
                      onClick={() => {
                        clearTimeout(hoverTimer.current);
                        if (playing) dub.stopPreview();
                        else
                          void dub.previewVoice(voice.id, undefined, speakerId);
                      }}
                    >
                      {playing ? (
                        dub.previewLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );
  },
);
VoiceLibrary.displayName = 'VoiceLibrary';
export default VoiceLibrary;
