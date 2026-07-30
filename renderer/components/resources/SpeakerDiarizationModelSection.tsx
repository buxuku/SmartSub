import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import { Download, FolderOpen, Trash2, Upload, Users, X } from 'lucide-react';
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
import DownloadSourcePopover, {
  type DownloadSourceConfig,
} from '@/components/resources/engines/DownloadSourcePopover';
import SherpaModelRow from '@/components/resources/SherpaModelRow';
import { importModelFromFolder } from 'lib/importModel';

type ModelSource = 'ghproxy' | 'github';
const SOURCES: ModelSource[] = ['ghproxy', 'github'];
const SOURCE_KEY = 'speakerDiarizationDownloadSource';
const PROGRESS_KEY = 'diarization:default';

function readSource(): ModelSource {
  if (typeof window === 'undefined') return 'ghproxy';
  return window.localStorage.getItem(SOURCE_KEY) === 'github'
    ? 'github'
    : 'ghproxy';
}

interface Status {
  success: boolean;
  installed: boolean;
  modelsPath: string;
}

const SpeakerDiarizationModelSection: React.FC<{
  globalDownloading?: boolean;
  onUpdate?: () => void;
}> = ({ globalDownloading = false, onUpdate }) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');
  const [status, setStatus] = useState<Status | null>(null);
  const [source, setSource] = useState<ModelSource>('ghproxy');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => setSource(readSource()), []);

  const load = useCallback(async () => {
    try {
      const result = await window?.ipc?.invoke(
        'getSpeakerDiarizationModelStatus',
      );
      if (result?.success) setStatus(result as Status);
    } catch {
      // 保留上次状态；资源页其余模型面板采用相同降级策略。
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubProgress = window?.ipc?.on(
      'downloadProgress',
      (key: string, value: number) => {
        if (key !== PROGRESS_KEY) return;
        setProgress(value);
        if (value >= 1) {
          void load();
          onUpdate?.();
        }
      },
    );
    const unsubDetail = window?.ipc?.on(
      'modelDownloadDetail',
      (key: string, detail: { status?: string }) => {
        if (key === PROGRESS_KEY) setPhase(detail?.status || '');
      },
    );
    return () => {
      unsubProgress?.();
      unsubDetail?.();
    };
  }, [load, onUpdate]);

  const selectSource = (value: string) => {
    const next: ModelSource = value === 'github' ? 'github' : 'ghproxy';
    setSource(next);
    window.localStorage.setItem(SOURCE_KEY, next);
  };

  const sourceConfig: DownloadSourceConfig = {
    value: source,
    options: SOURCES.map((value) => ({
      value,
      label: t(`engines.speakerDiarization.sources.${value}`),
    })),
    onChange: selectSource,
    label: t('engines.speakerDiarization.downloadSource'),
    confirmLabel: commonT('startDownload'),
    hint: t(`engines.speakerDiarization.sourceHints.${source}`),
  };

  const download = async () => {
    setDownloading(true);
    setProgress(0);
    try {
      const result = await window?.ipc?.invoke(
        'downloadSpeakerDiarizationModel',
        { source },
      );
      if (!result?.success) {
        toast.error(
          result?.error === 'anotherDownloadInProgress'
            ? t('engines.speakerDiarization.anotherDownload')
            : result?.error || t('engines.speakerDiarization.downloadFailed'),
        );
        return;
      }
      await load();
      onUpdate?.();
      toast.success(t('engines.speakerDiarization.downloaded'));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setDownloading(false);
      setProgress(0);
      setPhase('');
    }
  };

  const cancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(false);
  };

  const importFolder = async () => {
    const outcome = await importModelFromFolder(
      'speakerDiarization',
      'default',
    );
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

  const remove = async () => {
    setDeleteOpen(false);
    const result = await window?.ipc?.invoke('deleteSpeakerDiarizationModel');
    if (result?.success) {
      await load();
      onUpdate?.();
    } else {
      toast.error(
        result?.error || t('engines.speakerDiarization.deleteFailed'),
      );
    }
  };

  const openFolder = async () => {
    const result = await window?.ipc?.invoke('openModelsFolder', {
      pathType: 'speakerDiarization',
    });
    if (!result?.success) toast.error(result?.error || 'Open folder failed');
  };

  const installed = status?.installed === true;
  return (
    <>
      <SherpaModelRow
        icon={Users}
        name={t('engines.speakerDiarization.modelName')}
        desc={t('engines.speakerDiarization.modelDesc')}
        installed={installed}
        busy={downloading}
        progressPercent={Math.round(progress * 100)}
        phaseText={
          phase === 'extracting'
            ? t('engines.speakerDiarization.extracting')
            : undefined
        }
        progressWidthClass="w-48"
        trailing={
          downloading ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={cancel}
            >
              <X className="h-3.5 w-3.5" />
              {commonT('cancel')}
            </Button>
          ) : installed ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-muted-foreground"
                onClick={openFolder}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('openModelsFolder')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {commonT('delete')}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <DownloadSourcePopover
                open={sourceOpen}
                onOpenChange={setSourceOpen}
                config={sourceConfig}
                onConfirm={download}
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={globalDownloading}
                  onClick={() => setSourceOpen(true)}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('engines.speakerDiarization.download')}
                </Button>
              </DownloadSourcePopover>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-muted-foreground"
                disabled={globalDownloading}
                onClick={importFolder}
              >
                <Upload className="h-3.5 w-3.5" />
                {t('importFromFolder')}
              </Button>
            </div>
          )
        }
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{commonT('confirmDeleteModel')}</AlertDialogTitle>
            <AlertDialogDescription>
              {commonT('deleteModelDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{commonT('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={remove}
            >
              {commonT('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default SpeakerDiarizationModelSection;
