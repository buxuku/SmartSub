import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'next-i18next';
import {
  AlertCircle,
  Bot,
  Cpu,
  HelpCircle,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelHeader } from '@/components/ui/panel';
import { useAssistant } from '@/context/AssistantContext';
import { isMacPlatform } from '../../hooks/useHotkeys';
import { cn } from 'lib/utils';

interface AiAssistantGuideProps {
  locale: string;
  className?: string;
}

const PAIN_POINTS = [
  { key: 'modelSelection', icon: Cpu },
  { key: 'paramTuning', icon: SlidersHorizontal },
  { key: 'troubleshooting', icon: Wrench },
  { key: 'omnipresent', icon: HelpCircle },
] as const;

export default function AiAssistantGuide({
  locale,
  className,
}: AiAssistantGuideProps) {
  const { t } = useTranslation('launchpad');
  const assistant = useAssistant();
  const [hasProvider, setHasProvider] = useState<boolean | null>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(isMacPlatform());
  }, []);

  useEffect(() => {
    let mounted = true;
    const checkProviders = async () => {
      try {
        const list = await window?.ipc?.invoke('assistant:providers');
        if (mounted) {
          setHasProvider(Array.isArray(list) && list.length > 0);
        }
      } catch {
        if (mounted) {
          setHasProvider(false);
        }
      }
    };

    void checkProviders();

    const cleanup = window?.ipc?.on?.('assistant:event', () => {
      void checkProviders();
    });

    return () => {
      mounted = false;
      if (typeof cleanup === 'function') {
        cleanup();
      }
    };
  }, []);

  const shortcut = isMac ? '⌘J' : 'Ctrl+J';
  const isOpen = Boolean(assistant?.open);

  const handleToggle = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    assistant?.setOpen(!isOpen);
  };

  const handlePainPointClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    assistant?.setOpen(true);
  };

  return (
    <Panel
      className={cn('flex flex-1 min-h-0 flex-col', className)}
      aria-label={t('aiGuide.title')}
    >
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5 font-bold">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('aiGuide.title')}
          </span>
        }
        actions={
          <Badge
            variant="outline"
            className="gap-1 border-border/80 bg-background/50 font-mono text-[10px] text-muted-foreground"
          >
            {shortcut}
          </Badge>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col p-3">
        <p className="mb-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {t('aiGuide.desc')}
        </p>

        <ul className="space-y-1.5">
          {PAIN_POINTS.map((item) => {
            const ItemIcon = item.icon;
            return (
              <li
                key={item.key}
                onClick={handlePainPointClick}
                className="group flex h-[30px] items-center gap-2 rounded-md border border-border/35 bg-accent/30 px-2.5 text-xs text-foreground transition-all hover:border-primary/40 hover:bg-accent/60 cursor-pointer"
              >
                <ItemIcon className="h-3.5 w-3.5 flex-none text-primary transition-transform duration-150 group-hover:scale-110" />
                <span className="truncate text-[11.5px]">
                  {t(`aiGuide.painPoints.${item.key}`)}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-auto border-t border-border/60 pt-2.5">
          {hasProvider === false ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11.5px] text-amber-600 dark:text-amber-400">
                <AlertCircle className="h-3.5 w-3.5 flex-none" />
                <span className="truncate font-medium">
                  {t('aiGuide.notConfigured.title')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  asChild
                  size="sm"
                  className="h-8 flex-1 gap-1.5 text-xs font-medium shadow-sm"
                >
                  <Link href={`/${locale}/translation`}>
                    <Settings2 className="h-3.5 w-3.5" />
                    {t('aiGuide.notConfigured.action')}
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs font-medium"
                  data-assistant-toggle
                  aria-expanded={isOpen}
                  onClick={handleToggle}
                >
                  <Bot className="h-3.5 w-3.5" />
                  {isOpen
                    ? t('aiGuide.closeAssistant')
                    : t('aiGuide.openAssistant')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-0.5 text-xs">
                <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground font-medium">
                  <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_0_2px_hsl(var(--success)/0.2)]" />
                  {t('aiGuide.configured.title')}
                </span>
                <Link
                  href={`/${locale}/translation`}
                  className="text-[11px] text-primary hover:underline"
                >
                  {t('aiGuide.manageProviders')}
                </Link>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-8 w-full gap-1.5 shadow-sm text-xs font-medium"
                aria-keyshortcuts={isMac ? 'Meta+J' : 'Control+J'}
                data-assistant-toggle
                aria-expanded={isOpen}
                onClick={handleToggle}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>
                  {isOpen
                    ? t('aiGuide.closeAssistant')
                    : t('aiGuide.openAssistant')}
                </span>
                <span className="font-mono text-[10px] opacity-75">
                  ({shortcut})
                </span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
