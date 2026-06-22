import React from 'react';
import { useTranslation } from 'next-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isMacPlatform } from '../hooks/useHotkeys';

interface ShortcutsHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShortcutItem {
  /** 'mod' 渲染为 ⌘ 或 Ctrl */
  keys: string[];
  labelKey: string;
}

interface ShortcutGroup {
  groupKey: string;
  items: ShortcutItem[];
}

const GROUPS: ShortcutGroup[] = [
  {
    groupKey: 'shortcuts.groupGlobal',
    items: [
      { keys: ['mod', 'K'], labelKey: 'shortcuts.commandPalette' },
      { keys: ['mod', ','], labelKey: 'shortcuts.openSettings' },
      { keys: ['?'], labelKey: 'shortcuts.showShortcuts' },
    ],
  },
  {
    groupKey: 'shortcuts.groupTasks',
    items: [
      { keys: ['mod', 'O'], labelKey: 'shortcuts.importFiles' },
      { keys: ['mod', 'Enter'], labelKey: 'shortcuts.startTask' },
    ],
  },
  {
    groupKey: 'shortcuts.groupEditor',
    items: [
      { keys: ['mod', 'S'], labelKey: 'shortcuts.save' },
      { keys: ['mod', 'Z'], labelKey: 'shortcuts.undo' },
      { keys: ['Shift', 'mod', 'Z'], labelKey: 'shortcuts.redo' },
      { keys: ['Space'], labelKey: 'shortcuts.playPause' },
      { keys: ['↑', '↓'], labelKey: 'shortcuts.prevNextSubtitle' },
      { keys: ['Tab', 'Shift+Tab'], labelKey: 'shortcuts.switchSourceTarget' },
      { keys: ['mod', 'F'], labelKey: 'shortcuts.searchReplace' },
      { keys: ['Esc'], labelKey: 'shortcuts.exitInput' },
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

export default function ShortcutsHelpDialog({
  open,
  onOpenChange,
}: ShortcutsHelpDialogProps) {
  const { t } = useTranslation('common');
  const modLabel = isMacPlatform() ? '⌘' : 'Ctrl';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <div key={group.groupKey}>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(group.groupKey)}
              </div>
              <div className="divide-y rounded-md border">
                {group.items.map((item) => (
                  <div
                    key={item.labelKey}
                    className="flex items-center justify-between px-3 py-1.5 text-sm"
                  >
                    <span>{t(item.labelKey)}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((key, i) => (
                        <Kbd key={i}>{key === 'mod' ? modLabel : key}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
