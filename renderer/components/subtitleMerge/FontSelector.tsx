import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Check, ChevronsUpDown, RotateCcw, Search } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { acquireFontSample } from '../../lib/fontSampleCache';

interface FontOption {
  name: string;
  available: boolean;
  reason?: 'missing' | 'unsupported';
  embeddedId?: string;
  sampleRuns?: {
    text: string;
    fontName: string;
    fullName?: string;
    postscriptName?: string;
  }[];
}
export function FontSample({
  font,
  subtitlePath,
}: {
  font: FontOption;
  subtitlePath?: string | null;
}) {
  const { name, sampleRuns } = font;
  const { t } = useTranslation('subtitleMerge');
  const [families, setFamilies] = useState<string[]>();
  const [failed, setFailed] = useState(false);
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let stale = false;
    setFamilies(undefined);
    setFailed(false);
    if (!visible) return;
    if (sampleRuns && !sampleRuns.length) {
      setFailed(true);
      return;
    }
    const leases = (
      sampleRuns || [{ text: 'SmartSub 字幕示例 123', fontName: name }]
    ).map((run) =>
      acquireFontSample({
        name: run.fontName,
        fullName: run.fullName,
        subtitlePath,
        embeddedId: font.embeddedId,
        postscriptName: run.postscriptName,
      }),
    );
    Promise.all(leases.map((lease) => lease.promise)).then(
      (value) => {
        if (!stale) setFamilies(value);
      },
      () => {
        if (!stale) setFailed(true);
      },
    );
    return () => {
      stale = true;
      leases.forEach((lease) => lease.release());
    };
  }, [name, sampleRuns, subtitlePath, font.embeddedId, visible]);
  return (
    <span
      ref={element}
      data-font-sample={name}
      data-font-loaded={Boolean(families)}
      className="mt-1 block h-6 text-base leading-6"
    >
      {families
        ? (sampleRuns || [{ text: 'SmartSub 字幕示例 123' }]).map(
            (run, index) => (
              <span
                key={index}
                style={{ fontFamily: JSON.stringify(families[index]) }}
              >
                {run.text}
              </span>
            ),
          )
        : failed
          ? t('fontSampleFailed')
          : t('fontLoading')}
    </span>
  );
}

export default function FontSelector({
  value,
  onChange,
  disabled,
  subtitlePath,
}: {
  value: string;
  onChange: (name: string) => void;
  disabled: boolean;
  subtitlePath?: string | null;
}) {
  const { t } = useTranslation('subtitleMerge');
  const [fonts, setFonts] = useState<FontOption[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [parent, setParent] = useState<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setError(false);
    setLoading(true);
    window.ipc.invoke('subtitleMerge:listFonts', { subtitlePath }).then(
      (result) => {
        if (stale) return;
        setLoading(false);
        if (!result?.success || !Array.isArray(result.data)) {
          setError(true);
          return;
        }
        setFonts(result.data);
      },
      () => {
        if (!stale) {
          setLoading(false);
          setError(true);
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [attempt, subtitlePath, open]);
  const options = useMemo(() => {
    const all = fonts.some((font) => font.name === value)
      ? fonts
      : [
          { name: value, available: false, reason: 'missing' as const },
          ...fonts,
        ];
    return all.filter((font) =>
      font.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
  }, [fonts, value, query]);
  const rows = useVirtualizer({
    count: options.length,
    getScrollElement: () => parent,
    enabled: open,
    estimateSize: () => 64,
    overscan: 3,
  });
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const selected = options.findIndex(
      (font) => font.name === value && font.available,
    );
    const next =
      selected >= 0 ? selected : options.findIndex((font) => font.available);
    setActive(next);
    if (parent && next >= 0) rows.scrollToIndex(next, { align: 'auto' });
  }, [open, options, parent]);
  useEffect(() => {
    setOpen(false);
  }, [subtitlePath, disabled]);
  useEffect(() => {
    setFonts([]);
    setError(false);
  }, [subtitlePath]);
  const choose = (index: number) => {
    if (!disabled && !loading && !error && options[index]?.available) {
      onChange(options[index].name);
      setOpen(false);
    }
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
    let index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : active + direction;
    for (; index >= 0 && index < options.length; index += direction) {
      if (!options[index].available) continue;
      setActive(index);
      rows.scrollToIndex(index, { align: 'auto' });
      break;
    }
  };
  const failure = error && (
    <div
      role="alert"
      className="flex items-center gap-1 p-2 text-xs text-destructive"
    >
      {t('fontListFailed')}
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        aria-label={t('previewRetry')}
        disabled={loading}
        onClick={() => {
          setOpen(true);
          setAttempt((value) => value + 1);
        }}
      >
        <RotateCcw className="h-3 w-3" />
      </Button>
    </div>
  );
  return (
    <div className="min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-label={t('fontFamily')}
            aria-expanded={open}
            aria-controls={listId}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{value}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 flex-none opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[330px] max-w-[calc(100vw-32px)] p-0"
          align="start"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            search.current?.focus();
          }}
        >
          <div className="relative p-2">
            <Search className="absolute left-4 top-5 h-4 w-4 text-muted-foreground" />
            <Input
              ref={search}
              role="combobox"
              aria-label={t('fontSearch')}
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={
                rows.getVirtualItems().some((row) => row.index === active)
                  ? `${listId}-${active}`
                  : undefined
              }
              className="pl-8"
              value={query}
              placeholder={t('fontSearch')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={keyDown}
            />
          </div>
          <div
            ref={setParent}
            id={listId}
            role="listbox"
            aria-label={t('fontFamily')}
            data-testid="font-list"
            aria-busy={loading}
            className="h-[320px] overflow-y-auto bg-popover"
            style={{
              maxHeight:
                'max(128px, calc(var(--radix-popover-content-available-height) - 60px))',
            }}
          >
            <div
              className="relative w-full"
              style={{ height: rows.getTotalSize() }}
            >
              {rows.getVirtualItems().map((row) => {
                const font = options[row.index];
                return (
                  <div
                    key={font.name}
                    id={`${listId}-${row.index}`}
                    role="option"
                    aria-selected={font.name === value}
                    aria-disabled={!font.available || loading || error}
                    aria-posinset={row.index + 1}
                    aria-setsize={options.length}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(row.index)}
                    onMouseMove={() => setActive(row.index)}
                    className={`absolute left-0 top-0 w-full px-3 py-2 ${font.available ? 'cursor-pointer' : 'opacity-50'} ${active === row.index ? 'bg-accent' : ''}`}
                    style={{
                      height: row.size,
                      transform: `translateY(${row.start}px)`,
                    }}
                  >
                    <span className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 truncate" title={font.name}>
                        {font.name}
                      </span>
                      {font.name === value && (
                        <Check className="h-3 w-3 flex-none" />
                      )}
                      {!font.available && (
                        <span className="flex-none text-muted-foreground">
                          {t(
                            font.reason === 'unsupported'
                              ? 'fontUnsupported'
                              : 'fontMissing',
                          )}
                        </span>
                      )}
                    </span>
                    {font.available && (
                      <FontSample
                        key={font.embeddedId || font.name}
                        font={font}
                        subtitlePath={subtitlePath}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {!options.length && (
              <p className="p-3 text-sm text-muted-foreground">
                {t('fontNoResults')}
              </p>
            )}
          </div>
          {loading && (
            <p role="status" className="p-2 text-xs text-muted-foreground">
              {t('fontLoading')}
            </p>
          )}
          {failure}
        </PopoverContent>
      </Popover>
      {!open && failure}
    </div>
  );
}
