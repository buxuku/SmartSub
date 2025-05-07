import React, { FC } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'next-i18next';

interface IProps {
  loading?: boolean;
  progress?: number;
  handleDownModel?: () => void;
}

const DownModelButton: FC<IProps> = ({
  loading,
  progress,
  handleDownModel,
}) => {
  const { t } = useTranslation('common');
  return (
    <Button onClick={handleDownModel} variant="outline" disabled={loading}>
      {loading ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {progress ? `${(progress * 100).toFixed(2)}%` : t('downloading')}
        </>
      ) : (
        t('download')
      )}
    </Button>
  );
};

export default DownModelButton;
