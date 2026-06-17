import React from 'react';
import { useTranslation } from 'next-i18next';

const BuiltinPanel: React.FC = () => {
  const { t } = useTranslation('resources');
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('engines.builtin.desc')}
      </p>
    </div>
  );
};

export default BuiltinPanel;
