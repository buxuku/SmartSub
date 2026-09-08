import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Download, Trash2, X, Mic, Upload } from 'lucide-react';
import { toast } from 'sonner';
import DownloadSourcePopover, {
  type DownloadSourceConfig,
} from '@/components/resources/engines/DownloadSourcePopover';
import SherpaModelRow from '@/components/resources/SherpaModelRow';
import { importModelFromFolder } from 'lib/importModel';
import { resolveModelDownloadUrl } from 'lib/resolveModelDownloadUrl';
import {
  PARAKEET_MODEL_IDS,
  type ParakeetModelId,
} from '../../../types/parakeet';

type ParakeetModelSource = 'ghproxy' | 'github';

const PARAKEET_MODEL_SOURCES: ParakeetModelSource[] = ['ghproxy', 'github'];
const PARAKEET_SOURCE_STORAGE_KEY = 'parakeetModelDownloadSource';

function readParakeetModelSource(): ParakeetModelSource {
  if (typeof window === 'undefined') return 'ghproxy';
  const value = window.localStorage.getItem(PARAKEET_SOURCE_STORAGE_KEY);
  return value === 'github' || value === 'ghproxy' ? value : 'ghproxy';
}

interface ParakeetModelStatus {
  engineInstalled: boolean;
  vadInstalled: boolean;
  ready: boolean;
  models: { id: ParakeetModelId; installed: boolean }[];
}

const ParakeetModelSection: React.FC<{ onUpdate?: () => void }> = ({
  onUpdate,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');
  const [status, setStatus] = useState<ParakeetModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState<ParakeetModelId | null>(null);
  const [confirmId, setConfirmId] = useState<ParakeetModelId | null>(null);
  const [deleteId, setDeleteId] = useState<ParakeetModelId | null>(null);
  const [importing, setImporting] = useState<ParakeetModelId | null>(null);
  const [source, setSource] = useState<ParakeetModelSource>('ghproxy');

  useEffect(() => {
    setSource(readParakeetModelSource());
  }, []);

  const handleSelectSource = useCallback((next: ParakeetModelSource) => {
    setSource(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PARAKEET_SOURCE_STORAGE_KEY, next);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await window?.ipc?.invoke('getParakeetModelStatus');
      if (result?.success) setStatus(result as ParakeetModelStatus);
    } catch {
      // 保持上次状态
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubscribe = window?.ipc?.on(
      'downloadProgress',
      (key: string, value: number) => {
        if (typeof key !== 'string' || !key.startsWith('parakeet:')) return;
        setProgress((previous) => ({ ...previous, [key]: value }));
        if (value >= 1) {
          void load();
          onUpdate?.();
        }
      },
    );
    const unsubscribeDetail = window?.ipc?.on(
      'modelDownloadDetail',
      (key: string, detail: { status?: string }) => {
        if (typeof key !== 'string' || !key.startsWith('parakeet:')) return;
        setPhase((previous) => ({
          ...previous,
          [key]: detail?.status ?? '',
        }));
      },
    );
    return () => {
      unsubscribe?.();
      unsubscribeDetail?.();
    };
  }, [load, onUpdate]);

  const sourceConfig: DownloadSourceConfig = {
    value: source,
    options: PARAKEET_MODEL_SOURCES.map((item) => ({
      value: item,
      label: t(`engines.parakeet.modelSources.${item}`),
    })),
    onChange: (next) => handleSelectSource(next as ParakeetModelSource),
    label: t('engines.parakeet.downloadSource'),
    confirmLabel: commonT('startDownload'),
    hint: t(`engines.parakeet.modelSourceHint.${source}`),
    getCopyUrl: (next) =>
      resolveModelDownloadUrl('parakeet', next, confirmId || undefined),
  };

  const handleDownload = async (id: ParakeetModelId) => {
    setConfirmId(null);
    setDownloading(id);
    setPhase((previous) => ({ ...previous, [`parakeet:${id}`]: '' }));
    try {
      const result = await window?.ipc?.invoke('downloadParakeetModel', {
        model: id,
        source,
      });
      if (result?.success) {
        await load();
        onUpdate?.();
      } else if (!String(result?.error).includes('Download cancelled')) {
        toast.error(
          result?.error === 'anotherDownloadInProgress'
            ? t('engines.parakeet.anotherDownload')
            : result?.error || 'Failed to download model',
        );
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setDownloading(null);
      setProgress((previous) => ({ ...previous, [`parakeet:${id}`]: 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
  };

  const handleImport = async (id: ParakeetModelId) => {
    setImporting(id);
    try {
      const outcome = await importModelFromFolder('parakeet', id);
      if (outcome.kind === 'success') {
        toast.success(t('importModelSuccess'), { duration: 2000 });
        await load();
        onUpdate?.();
      } else if (outcome.kind === 'invalid-layout') {
        toast.error(
          t('importInvalidLayout', { files: outcome.missing.join(', ') }),
        );
      } else if (outcome.kind === 'error') {
        toast.error(t('importModelFailed', { error: outcome.message }));
      }
    } finally {
      setImporting(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const id = deleteId;
    setDeleteId(null);
    const result = await window?.ipc?.invoke('deleteParakeetModel', id);
    if (result?.success) {
      await load();
      onUpdate?.();
    } else {
      toast.error(result?.error || 'Failed to delete model');
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-baseline gap-2 px-1">
          <Mic className="h-4 w-4 self-center text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t('engines.parakeet.modelsTitle')}
          </h3>
        </div>
        <div className="space-y-2">
          {PARAKEET_MODEL_IDS.map((id) => {
            const installed =
              status?.models.find((model) => model.id === id)?.installed ??
              false;
            const busy = downloading === id;
            const progressKey = `parakeet:${id}`;
            return (
              <SherpaModelRow
                key={id}
                icon={Mic}
                name={t(`engines.parakeet.models.${id}.name`)}
                desc={t(`engines.parakeet.models.${id}.desc`)}
                installed={installed}
                busy={busy}
                progressPercent={Math.round((progress[progressKey] ?? 0) * 100)}
                phaseText={
                  phase[progressKey] === 'extracting'
                    ? t('engines.parakeet.extracting')
                    : undefined
                }
                progressWidthClass="w-44"
                trailing={
                  busy ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-muted-foreground"
                      onClick={handleCancel}
                    >
                      <X className="h-3.5 w-3.5" />
                      {commonT('cancel')}
                    </Button>
                  ) : installed ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-muted-foreground hover:text-destructive"
                      disabled={!!downloading || !!importing}
                      onClick={() => setDeleteId(id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('engines.parakeet.modelDelete')}
                    </Button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <DownloadSourcePopover
                        open={confirmId === id}
                        onOpenChange={(open) => setConfirmId(open ? id : null)}
                        config={sourceConfig}
                        onConfirm={() => handleDownload(id)}
                      >
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          disabled={!!downloading || !!importing}
                          onClick={() => setConfirmId(id)}
                        >
                          <Download className="h-3.5 w-3.5" />
                          {t('engines.parakeet.modelDownload')}
                        </Button>
                      </DownloadSourcePopover>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5 text-muted-foreground"
                        disabled={!!downloading || !!importing}
                        onClick={() => handleImport(id)}
                      >
                        <Upload className="h-3.5 w-3.5" />
                        {t('importFromFolder')}
                      </Button>
                    </div>
                  )
                }
              />
            );
          })}
        </div>
      </section>

      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              {commonT('confirmDeleteModel')}
              {deleteId ? `: ${deleteId}` : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {commonT('deleteModelDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
              {commonT('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ParakeetModelSection;
