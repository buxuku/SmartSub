import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type {
  TaskStorageStatus,
  TaskStorageMigrationPreview,
  TaskStorageCleanupResult,
} from '../../../types/taskStorage';

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export default function TaskStorageSettings({
  storageRoot,
}: {
  storageRoot: string;
}) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<TaskStorageStatus>();
  const [preview, setPreview] = useState<TaskStorageMigrationPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    setStatus(await window.ipc.invoke('taskStorage:status'));
  }, []);
  useEffect(() => {
    let current = true;
    void window.ipc
      .invoke('taskStorage:status')
      .then((value) => {
        if (current) setStatus(value);
      })
      .catch((cause) => {
        if (current) setError(String(cause));
      });
    return () => {
      current = false;
    };
  }, [storageRoot]);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const migration = status?.migration;
  return (
    <div className="space-y-3 border-t pt-4" aria-label={t('taskStorageTitle')}>
      <div className="font-medium">{t('taskStorageTitle')}</div>
      <p className="text-xs text-muted-foreground">{t('taskStorageHint')}</p>
      {status && (
        <div className="space-y-2 text-xs">
          {status.roots.map((root) => (
            <div key={root.path} className="space-y-1">
              <div>
                {root.path === status.root
                  ? t('taskStorageCurrent')
                  : t('taskStoragePrevious')}{' '}
                · {size(root.bytes)}
                {!root.available && ` · ${t('taskStorageUnavailable')}`}
              </div>
              <div className="font-mono break-all text-muted-foreground">
                {root.path}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const result: TaskStorageCleanupResult = await window.ipc.invoke(
                'taskStorage:cleanup',
              );
              setMessage(t('taskStorageCleaned', { size: size(result.bytes) }));
              if (result.errors.length) setError(result.errors.join('\n'));
            })
          }
        >
          {t('taskStorageCleanup')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || migration?.phase === 'scheduled'}
          onClick={() =>
            void perform(async () => {
              setPreview(
                await window.ipc.invoke('taskStorage:previewMigration'),
              );
            })
          }
        >
          {t('taskStorageMigrate')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void perform(refresh)}
        >
          {t('taskStorageRefresh')}
        </Button>
      </div>
      {migration?.phase === 'scheduled' && (
        <div className="space-y-2">
          <p className="text-xs">{t('taskStorageScheduled')}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await window.ipc.invoke('restart-app');
                })
              }
            >
              {t('taskStorageRestart')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await window.ipc.invoke('taskStorage:cancelMigration');
                })
              }
            >
              {t('taskStorageCancel')}
            </Button>
          </div>
        </div>
      )}
      {migration?.phase === 'done' && (
        <p className="text-xs text-muted-foreground">
          {t('taskStorageMigrated')}
        </p>
      )}
      {migration?.phase === 'cleanup' && (
        <div className="space-y-2">
          <p className="text-xs">{t('taskStorageCleanupPending')}</p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await window.ipc.invoke('restart-app');
              })
            }
          >
            {t('taskStorageRetry')}
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
      {(error || migration?.error) && (
        <p
          role="alert"
          className="text-xs text-destructive whitespace-pre-wrap break-all"
        >
          {error || migration?.error}
        </p>
      )}
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('taskStorageMigrate')}</DialogTitle>
            <DialogDescription>
              {t('taskStorageMigrationHint')}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 text-sm">
              <div>
                {t('taskStorageMigrationSize', {
                  count: preview.files,
                  size: size(preview.bytes),
                })}
              </div>
              <div className="font-mono text-xs break-all">
                {preview.target}
              </div>
              <div className="max-h-40 overflow-auto text-xs space-y-1">
                {preview.sources.map((source) => (
                  <div className="break-all" key={source}>
                    {source}
                  </div>
                ))}
              </div>
              {preview.blockers.length > 0 && (
                <p
                  role="alert"
                  className="text-destructive whitespace-pre-wrap break-all"
                >
                  {preview.blockers.join('\n')}
                </p>
              )}
              {error && (
                <p role="alert" className="text-destructive break-all">
                  {error}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setPreview(undefined)}
            >
              {t('taskStorageCancel')}
            </Button>
            <Button
              disabled={busy || !preview?.files || !!preview?.blockers.length}
              onClick={() =>
                void perform(async () => {
                  await window.ipc.invoke(
                    'taskStorage:scheduleMigration',
                    preview!.id,
                  );
                  setPreview(undefined);
                })
              }
            >
              {t('taskStorageSchedule')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
