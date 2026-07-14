import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { useTheme } from 'next-themes';
import {
  AudioLines,
  Captions,
  Clapperboard,
  Compass,
  Cpu,
  Github,
  HelpCircle,
  Home,
  Keyboard,
  Languages,
  Mic,
  Moon,
  PenLine,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  Sun,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { openUrl } from 'lib/utils';
import { getWorkItemTarget } from 'lib/workItemUtils';
import type { WorkItem } from '../../types/workItem';

/**
 * 全局命令面板（Cmd+K）：跳转 / 最近工程 / 全局动作。
 * 复用既有 cmdk 基元；动作均复用既有 handler，v1 不含破坏性操作、不新增后端能力。
 */
export default function CommandPalette({
  open,
  onOpenChange,
  locale,
  onCheckUpdates,
  onOpenLogs,
  onOpenShortcuts,
  onOpenFaq,
  onOpenOnboarding,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: string;
  onCheckUpdates: () => void;
  onOpenLogs: () => void;
  onOpenShortcuts: () => void;
  onOpenFaq: () => void;
  onOpenOnboarding: () => void;
}) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const { setTheme, theme } = useTheme();
  const [recent, setRecent] = useState<WorkItem[]>([]);

  const loadRecent = useCallback(async () => {
    try {
      const items: WorkItem[] = await window?.ipc?.invoke('getWorkItems');
      const sorted = (items || [])
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 5);
      setRecent(sorted);
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    if (open) loadRecent();
  }, [open, loadRecent]);

  // 跳转：直接关闭并路由
  const navTo = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  // 触发会打开其它 Dialog 的动作：先关面板再延迟执行，避免 Radix body pointer-events 争用
  const runDeferred = (fn: () => void) => {
    onOpenChange(false);
    setTimeout(fn, 0);
  };

  const nav = [
    { href: 'home', label: t('nav.launchpad'), icon: Home },
    {
      href: 'tasks/generate-translate',
      label: t('nav.subtitles'),
      icon: Captions,
    },
    { href: 'proofread', label: t('nav.proofread'), icon: PenLine },
    { href: 'subtitleMerge', label: t('nav.compose'), icon: Clapperboard },
    { href: 'dubbing', label: t('nav.dubbing'), icon: Mic },
    { href: 'engines', label: t('nav.engines'), icon: Cpu },
    { href: 'translation', label: t('nav.translation'), icon: Languages },
    { href: 'ttsServices', label: t('nav.voices'), icon: AudioLines },
    { href: 'recent-tasks', label: t('cmd.recentTasks'), icon: ScrollText },
    { href: 'settings', label: t('nav.settings'), icon: Settings },
  ];

  const newTasks = [
    { slug: 'generate-translate', label: t('cmd.newGenerateTranslate') },
    { slug: 'generate', label: t('cmd.newGenerate') },
    { slug: 'translate', label: t('cmd.newTranslate') },
  ];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t('cmd.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('cmd.empty')}</CommandEmpty>

        <CommandGroup heading={t('cmd.groupNav')}>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.href}
                value={`nav ${item.label}`}
                onSelect={() => navTo(`/${locale}/${item.href}`)}
              >
                <Icon />
                <span>{item.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        {recent.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('cmd.groupRecent')}>
              {recent.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`recent ${item.name}`}
                  onSelect={() => navTo(getWorkItemTarget(item, locale))}
                >
                  <ScrollText />
                  <span className="truncate">{item.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading={t('cmd.groupActions')}>
          {newTasks.map((item) => (
            <CommandItem
              key={item.slug}
              value={`action ${item.label}`}
              onSelect={() => navTo(`/${locale}/tasks/${item.slug}`)}
            >
              <Plus />
              <span>{item.label}</span>
            </CommandItem>
          ))}
          <CommandItem
            value={`action ${t('toggleTheme')}`}
            onSelect={() => {
              setTheme(theme === 'light' ? 'dark' : 'light');
              onOpenChange(false);
            }}
          >
            {theme === 'light' ? <Moon /> : <Sun />}
            <span>{t('toggleTheme')}</span>
          </CommandItem>
          <CommandItem
            value={`action ${t('help.checkUpdates')}`}
            onSelect={() => {
              onOpenChange(false);
              onCheckUpdates();
            }}
          >
            <RefreshCw />
            <span>{t('help.checkUpdates')}</span>
          </CommandItem>
          <CommandItem
            value={`action ${t('viewLogs')}`}
            onSelect={() => runDeferred(onOpenLogs)}
          >
            <ScrollText />
            <span>{t('viewLogs')}</span>
          </CommandItem>
          <CommandItem
            value={`action ${t('help.shortcuts')}`}
            onSelect={() => runDeferred(onOpenShortcuts)}
          >
            <Keyboard />
            <span>{t('help.shortcuts')}</span>
          </CommandItem>
          <CommandItem
            value={`action ${t('help.faq')}`}
            onSelect={() => runDeferred(onOpenFaq)}
          >
            <HelpCircle />
            <span>{t('help.faq')}</span>
          </CommandItem>
          <CommandItem
            value={`action ${t('help.reopenOnboarding')}`}
            onSelect={() => runDeferred(onOpenOnboarding)}
          >
            <Compass />
            <span>{t('help.reopenOnboarding')}</span>
          </CommandItem>
          <CommandItem
            value={`action ${t('help.github')}`}
            onSelect={() => {
              onOpenChange(false);
              openUrl('https://github.com/buxuku/SmartSub');
            }}
          >
            <Github />
            <span>{t('help.github')}</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
