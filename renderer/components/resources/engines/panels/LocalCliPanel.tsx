import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Check, Info } from 'lucide-react';

interface LocalCliPanelProps {
  whisperCommand: string;
  onCommandChange: (value: string) => void;
  onSave: () => void;
}

const LocalCliPanel: React.FC<LocalCliPanelProps> = ({
  whisperCommand,
  onCommandChange,
  onSave,
}) => {
  const { t } = useTranslation('resources');
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t('engines.localCli.desc')}
      </p>
      <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center gap-1.5">
          <label htmlFor="localcli-command" className="text-sm font-medium">
            {t('engines.localCli.commandLabel')}
          </label>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('engines.localCli.commandLabel')}
                className="text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] whitespace-pre-line text-xs leading-relaxed">
              {t('engines.localCli.commandTooltip')}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex gap-2">
          <Input
            id="localcli-command"
            value={whisperCommand}
            onChange={(e) => onCommandChange(e.target.value)}
            placeholder={t('engines.localCli.commandPlaceholder')}
            className="font-mono text-sm"
          />
          <Button size="sm" className="shrink-0 gap-1.5" onClick={onSave}>
            <Check className="h-3.5 w-3.5" />
            {t('engines.localCli.save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('engines.localCli.commandHint')}
        </p>
      </div>
    </div>
  );
};

export default LocalCliPanel;
