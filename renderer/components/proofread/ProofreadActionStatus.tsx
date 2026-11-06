import { useTranslation } from 'next-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';

export function ProofreadActionStatus({
  busy,
  error,
  retry,
}: {
  busy: boolean;
  error: string;
  retry: () => void;
}) {
  const { t } = useTranslation('home');
  const { t: commonT } = useTranslation('common');
  if (busy)
    return (
      <div
        role="status"
        className="flex items-center gap-2 bg-muted/40 p-3 text-sm"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('proofreadImportState.loading')}
      </div>
    );
  if (!error) return null;
  return (
    <div role="alert" className="space-y-2 bg-destructive/10 p-3 text-sm">
      <p>{t('proofreadImportState.failed')}</p>
      <p className="text-muted-foreground">
        {t('proofreadImportState.repair')}
      </p>
      <details>
        <summary>{commonT('saveState.details')}</summary>
        <p className="break-all whitespace-pre-wrap">{error}</p>
      </details>
      <Button variant="outline" size="sm" onClick={retry}>
        <RefreshCw className="mr-2 h-4 w-4" />
        {t('proofreadImportState.retry')}
      </Button>
    </div>
  );
}
