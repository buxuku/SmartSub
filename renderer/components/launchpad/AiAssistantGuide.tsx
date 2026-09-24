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

  const handleToggle = () => {
    assistant?.setOpen(!isOpen);
  };

  return (
    <Panel
      className={cn('min-h-fit flex-1', className)}
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
      <div className="flex flex-1 flex-col justify-between p-3 pt-1">
        <div className="space-y-2.5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('aiGuide.desc')}
          </p>

          <ul className="space-y-2">
            {PAIN_POINTS.map((item) => {
              const ItemIcon = item.icon;
              return (
                <li key={item.key} className="flex items-start gap-2 text-xs">
                  <span className="flex h-5 w-5 flex-none items-center justify-center rounded-md bg-primary/10 text-primary">
                    <ItemIcon className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium leading-5 text-foreground">
                      {t(`aiGuide.painPoints.${item.key}.title`)}
                    </h3>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      {t(`aiGuide.painPoints.${item.key}.desc`)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="mt-3 border-t border-border/60 pt-2.5">
          {hasProvider === false ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-2.5 text-xs dark:bg-amber-500/10">
              <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-300">
                <AlertCircle className="h-3.5 w-3.5 flex-none" />
                <span>{t('aiGuide.notConfigured.title')}</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t('aiGuide.notConfigured.desc')}
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <Button
                  asChild
                  size="sm"
                  className="h-7.5 flex-1 gap-1 text-xs"
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
                  className="h-7.5 gap-1 text-xs"
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
                <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
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
                className="w-full gap-1.5 shadow-sm"
                aria-keyshortcuts={isMac ? 'Meta+J' : 'Control+J'}
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
