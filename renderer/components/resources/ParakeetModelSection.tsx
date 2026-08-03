import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
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

type ParakeetModelId = 'parakeet-tdt-0.6b-v3';
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

const MODEL_ID: ParakeetModelId = 'parakeet-tdt-0.6b-v3';
const PROGRESS_KEY = `parakeet:${MODEL_ID}`;

const ParakeetModelSection: React.FC<{ onUpdate?: () => void }> = ({
  onUpdate,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');
  const [status, setStatus] = useState<ParakeetModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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

  const installed =
    status?.models.find((model) => model.id === MODEL_ID)?.installed ?? false;

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
    getCopyUrl: (next) => resolveModelDownloadUrl('parakeet', next, MODEL_ID),
  };

  const handleDownload = async () => {
    setShowConfirm(false);
    setDownloading(true);
    try {
      const result = await window?.ipc?.invoke('downloadParakeetModel', {
        model: MODEL_ID,
        source,
      });
      if (result?.success) {
        await load();
        onUpdate?.();
      } else {
        toast.error(
          result?.error === 'anotherDownloadInProgress'
            ? t('engines.parakeet.anotherDownload')
            : result?.error || 'Failed to download model',
        );
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setDownloading(false);
      setProgress((previous) => ({ ...previous, [PROGRESS_KEY]: 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(false);
  };

  const handleImport = async () => {
    const outcome = await importModelFromFolder('parakeet', MODEL_ID);
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
  };

  const handleDelete = async () => {
    setShowDeleteConfirm(false);
    const result = await window?.ipc?.invoke('deleteParakeetModel', MODEL_ID);
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
        <Card>
          <CardContent className="space-y-2 p-2">
            <SherpaModelRow
              icon={Mic}
              name={t(`engines.parakeet.models.${MODEL_ID}.name`)}
              desc={t(`engines.parakeet.models.${MODEL_ID}.desc`)}
              installed={installed}
              busy={downloading}
              progressPercent={Math.round((progress[PROGRESS_KEY] ?? 0) * 100)}
              phaseText={
                phase[PROGRESS_KEY] === 'extracting'
                  ? t('engines.parakeet.extracting')
                  : undefined
              }
              progressWidthClass="w-44"
              trailing={
                downloading ? (
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
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('engines.parakeet.modelDelete')}
                  </Button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <DownloadSourcePopover
                      open={showConfirm}
                      onOpenChange={setShowConfirm}
                      config={sourceConfig}
                      onConfirm={handleDownload}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => setShowConfirm(true)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t('engines.parakeet.modelDownload')}
                      </Button>
                    </DownloadSourcePopover>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-muted-foreground"
                      onClick={handleImport}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {t('importFromFolder')}
                    </Button>
                  </div>
                )
              }
            />
          </CardContent>
        </Card>
      </section>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{commonT('confirmDeleteModel')}</AlertDialogTitle>
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
