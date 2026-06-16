import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Bot } from 'lucide-react';

const BuiltinPanel: React.FC<{ onGoModels?: () => void }> = ({
  onGoModels,
}) => {
  const { t } = useTranslation('resources');
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('engines.builtin.desc')}
      </p>
      {onGoModels && (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onGoModels}
        >
          <Bot className="h-3.5 w-3.5" />
          {t('overview.modelsTitle')}
        </Button>
      )}
    </div>
  );
};

export default BuiltinPanel;
