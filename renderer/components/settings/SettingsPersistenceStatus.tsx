import { useTranslation } from 'next-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import type { useSettingsPersistence } from '../../hooks/useSettingsPersistence';

export default function SettingsPersistenceStatus({
  state,
}: {
  state: ReturnType<typeof useSettingsPersistence>;
}) {
  const { t } = useTranslation('settings');
  const { t: commonT } = useTranslation('common');
  const failure = state.loadError || state.error;
  return (
    <div className="shrink-0 space-y-2" data-settings-persistence>
      <p role="status" className="text-xs text-muted-foreground">
        {state.loading
          ? t('persistence.loading')
          : !state.loaded
            ? t('persistence.loadFailed')
            : commonT(
                `saveState.${state.saving ? 'saving' : state.error ? 'save_error' : state.isDirty ? 'dirty' : 'saved'}`,
              )}
      </p>
      {failure && (
        <div
          role="alert"
          className="max-h-48 overflow-y-auto space-y-2 bg-destructive/10 p-3 text-sm"
        >
          <p>{t(state.loaded ? 'saveFailed' : 'persistence.loadFailed')}</p>
          <p>{t('persistence.repair')}</p>
          <details>
            <summary>{commonT('saveState.details')}</summary>
            <p className="break-all whitespace-pre-wrap">{failure}</p>
          </details>
          <Button
            size="sm"
            variant="outline"
            disabled={state.loading || state.saving}
            onClick={() => void (state.loaded ? state.save() : state.load())}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {state.loaded
              ? commonT('saveState.retry')
              : t('persistence.reload')}
          </Button>
        </div>
      )}
    </div>
  );
}
