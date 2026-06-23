import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ChevronDown } from 'lucide-react';
import { cn } from 'lib/utils';

interface FaqDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** hasCommand 的条目在答案下方以 <code> 块展示可复制命令（key 后缀 Cmd） */
const FAQ_ITEMS = [
  { id: 'macDamaged', hasCommand: true },
  { id: 'cudaCrash', hasCommand: false },
  { id: 'slowDownload', hasCommand: false },
  { id: 'translateFailed', hasCommand: false },
  { id: 'subtitleGarbled', hasCommand: false },
] as const;

export default function FaqDialog({ open, onOpenChange }: FaqDialogProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[70vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('faq.title')}</DialogTitle>
        </DialogHeader>
        <div className="divide-y rounded-md border">
          {FAQ_ITEMS.map((item) => {
            const isOpen = expanded === item.id;
            return (
              <div key={item.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium hover:bg-muted/50"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : item.id)}
                >
                  {t(`faq.${item.id}Q`)}
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform',
                      isOpen && 'rotate-180',
                    )}
                  />
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 text-sm leading-relaxed text-muted-foreground">
                    {t(`faq.${item.id}A`)}
                    {item.hasCommand && (
                      <code className="mt-2 block select-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
                        {t(`faq.${item.id}Cmd`)}
                      </code>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
