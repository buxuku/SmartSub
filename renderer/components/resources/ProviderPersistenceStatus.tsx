import { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { RefreshCw, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

export default function ProviderPersistenceStatus({
  state,
  quiet = false,
}: {
  quiet?: boolean;
  state: {
    loaded: boolean;
    loading: boolean;
    loadError: string;
    error: string;
    saving: boolean;
    isDirty: boolean;
    load: () => Promise<boolean>;
    save: () => Promise<boolean>;
    discard: () => Promise<boolean>;
  };
}) {
  const { t } = useTranslation('common');
  const [confirmReload, setConfirmReload] = useState(false);
  const failure = state.loadError || state.error;
  return (
    <div className="shrink-0 space-y-2" data-provider-persistence>
      <p
        role="status"
        className={
          quiet &&
          state.loaded &&
          !state.isDirty &&
          !state.error &&
          !state.saving
            ? 'sr-only'
            : 'text-xs text-muted-foreground'
        }
      >
        {state.loading
          ? t('providerPersistence.loading')
          : !state.loaded
            ? t('providerPersistence.loadFailed')
            : t(
                `saveState.${state.saving ? 'saving' : state.error ? 'save_error' : state.isDirty ? 'dirty' : 'saved'}`,
              )}
      </p>
      {failure && (
        <div
          role="alert"
          className="max-h-48 overflow-y-auto space-y-2 bg-destructive/10 p-3 text-sm"
        >
          <p>
            {t(
              !state.loaded
                ? 'providerPersistence.loadFailed'
                : 'providerPersistence.saveFailed',
            )}
          </p>
          <p>
            {t(
              failure.includes('PROVIDER_SETTINGS_CONFLICT')
                ? 'providerPersistence.conflict'
                : 'providerPersistence.repair',
            )}
          </p>
          <details>
            <summary>{t('saveState.details')}</summary>
            <p className="break-all whitespace-pre-wrap">{failure}</p>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={state.loading || state.saving}
              onClick={() => void (state.loaded ? state.save() : state.load())}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t(
                state.loaded ? 'saveState.retry' : 'providerPersistence.reload',
              )}
            </Button>
            {state.loaded && (
              <Button
                size="sm"
                variant="outline"
                disabled={state.saving}
                onClick={() => setConfirmReload(true)}
              >
                <Undo2 className="mr-2 h-4 w-4" />
                {t('providerPersistence.discardReload')}
              </Button>
            )}
          </div>
        </div>
      )}
      <AlertDialog open={confirmReload} onOpenChange={setConfirmReload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('providerPersistence.discardReload')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('providerPersistence.discardDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <Button
              onClick={async () => {
                await state.discard();
                setConfirmReload(false);
                await state.load();
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('providerPersistence.discardReload')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
