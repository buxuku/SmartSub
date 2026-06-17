import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
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
  enabled: boolean;
  onToggleEnabled: (value: boolean) => void;
}

const LocalCliPanel: React.FC<LocalCliPanelProps> = ({
  whisperCommand,
  onCommandChange,
  onSave,
  enabled,
  onToggleEnabled,
}) => {
  const { t } = useTranslation('resources');
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t('engines.localCli.desc')}
      </p>

      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
        <div className="min-w-0">
          <Label htmlFor="localcli-enable" className="text-sm font-medium">
            {t('engines.localCli.enable')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('engines.localCli.enableHint')}
          </p>
        </div>
        <Switch
          id="localcli-enable"
          checked={enabled}
          onCheckedChange={onToggleEnabled}
        />
      </div>

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
        <Textarea
          id="localcli-command"
          value={whisperCommand}
          onChange={(e) => onCommandChange(e.target.value)}
          placeholder={t('engines.localCli.commandPlaceholder')}
          rows={4}
          className="font-mono text-sm"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t('engines.localCli.commandHint')}
          </p>
          <Button size="sm" className="shrink-0 gap-1.5" onClick={onSave}>
            <Check className="h-3.5 w-3.5" />
            {t('engines.localCli.save')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default LocalCliPanel;
