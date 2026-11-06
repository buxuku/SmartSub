import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';

export default function TaskLoadStatus({
  error,
  loading,
  onRetry,
  project = false,
}: {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  project?: boolean;
}) {
  const { t } = useTranslation('tasks');
  return (
    <div className="flex h-full items-center justify-center p-4">
      {error ? (
        <div
          role="alert"
          className="max-w-lg space-y-3 rounded-lg bg-destructive/10 p-4 text-sm"
        >
          <p className="font-medium">
            {t(project ? 'projectSave.loadFailed' : 'configLoad.failed')}
          </p>
          <p className="text-muted-foreground">{t('configLoad.repair')}</p>
          <details className="text-xs">
            <summary className="cursor-pointer">
              {t('projectSave.details')}
            </summary>
            <p className="mt-2 break-words">{error}</p>
          </details>
          <Button disabled={loading} onClick={onRetry}>
            {t('projectSave.retryLoad')}
          </Button>
        </div>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t(project ? 'projectSave.loading' : 'configLoad.loading')}
        </p>
      )}
    </div>
  );
}
