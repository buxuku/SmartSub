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
import SherpaModelRow from '@/components/resources/SherpaModelRow';
import DownloadSourcePopover, {
  useDownloadSource,
} from '@/components/resources/engines/DownloadSourcePopover';
import {
  formatFunasrDownloadFailureToast,
  isFunasrDownloadCancelled,
} from '@/lib/funasrDownloadError';
import { importModelFromFolder } from 'lib/importModel';
import { resolveModelDownloadUrl } from 'lib/resolveModelDownloadUrl';

type FunasrModelId = 'sensevoice-small' | 'paraformer-zh' | 'silero-vad';

interface FunasrModelStatus {
  baseReady: boolean;
  engineInstalled: boolean;
  ready: boolean;
  models: { id: FunasrModelId; installed: boolean }[];
}

const ASR_MODELS: FunasrModelId[] = ['sensevoice-small', 'paraformer-zh'];

const FunasrModelSection: React.FC<{
  onUpdate?: () => void;
  downSource?: string;
}> = ({ onUpdate, downSource = 'hf-mirror' }) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [status, setStatus] = useState<FunasrModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [downloading, setDownloading] = useState<FunasrModelId | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<FunasrModelId | null>(
    null,
  );
  // 下载源在「点击下载时」于气泡内选择（源配置来自上层 ModelLibrarySection 的 Context）。
  const sourceConfig = useDownloadSource();
  const [pickerId, setPickerId] = useState<FunasrModelId | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('getFunasrModelStatus');
      if (r?.success) setStatus(r as FunasrModelStatus);
    } catch {
      // 保持上次状态
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = window?.ipc?.on(
      'downloadProgress',
      (key: string, value: number) => {
        if (typeof key !== 'string' || !key.startsWith('funasr:')) return;
        setProgress((prev) => ({ ...prev, [key]: value }));
        if (value >= 1) {
          void load();
          onUpdate?.();
        }
      },
    );
    return () => {
      unsub?.();
    };
  }, [load, onUpdate]);

  const isInstalled = (id: FunasrModelId) =>
    status?.models.find((m) => m.id === id)?.installed ?? false;

  const handleDownload = async (id: FunasrModelId) => {
    setDownloading(id);
    try {
      const r = await window?.ipc?.invoke('downloadFunasrModel', {
        model: id,
        source: downSource,
      });
      if (r?.success) {
        await load();
        onUpdate?.();
      } else {
        if (isFunasrDownloadCancelled(r?.error)) {
          return;
        }
        if (r?.error === 'anotherDownloadInProgress') {
          toast.error(t('engines.funasr.anotherDownload'));
        } else {
          const failure = formatFunasrDownloadFailureToast(
            t,
            id,
            r?.error || '',
          );
          toast.error(failure.title, {
            description: failure.description,
            duration: 8000,
          });
        }
      }
    } catch (e) {
      if (isFunasrDownloadCancelled(e)) return;
      const failure = formatFunasrDownloadFailureToast(t, id, String(e));
      toast.error(failure.title, {
        description: failure.description,
        duration: 8000,
      });
    } finally {
      setDownloading(null);
      setProgress((prev) => ({ ...prev, [`funasr:${id}`]: 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(null);
  };

  const handleImport = async (id: FunasrModelId) => {
    const o = await importModelFromFolder('funasr', id);
    if (o.kind === 'success') {
      toast.success(t('importModelSuccess'), { duration: 2000 });
      await load();
      onUpdate?.();
    } else if (o.kind === 'invalid-layout') {
      toast.error(t('importInvalidLayout', { files: o.missing.join(', ') }));
    } else if (o.kind === 'error') {
      toast.error(t('importModelFailed', { error: o.message }));
    }
  };

  const handleDelete = async (id: FunasrModelId) => {
    const r = await window?.ipc?.invoke('deleteFunasrModel', id);
    if (r?.success) {
      await load();
      onUpdate?.();
    } else {
      toast.error(r?.error || 'Failed to delete model');
    }
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    await handleDelete(id);
  };

  const renderRow = (id: FunasrModelId, Icon: typeof Mic) => {
    const installed = isInstalled(id);
    const isBusy = downloading === id;
    const pct = Math.round((progress[`funasr:${id}`] ?? 0) * 100);
    const trailing = isBusy ? (
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
        onClick={() => setConfirmDeleteId(id)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t('engines.funasr.modelDelete')}
      </Button>
    ) : (
      <div className="flex items-center gap-1.5">
        {(() => {
          const downloadBtn = (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={!!downloading}
              onClick={() =>
                sourceConfig ? setPickerId(id) : handleDownload(id)
              }
            >
              <Download className="h-3.5 w-3.5" />
              {t('engines.funasr.modelDownload')}
            </Button>
          );
          return sourceConfig ? (
            <DownloadSourcePopover
              open={pickerId === id}
              onOpenChange={(o) => setPickerId(o ? id : null)}
              config={sourceConfig}
              onConfirm={() => handleDownload(id)}
              getCopyUrl={(s) => resolveModelDownloadUrl('funasr', s, id)}
            >
              {downloadBtn}
            </DownloadSourcePopover>
          ) : (
            downloadBtn
          );
        })()}
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 text-muted-foreground"
          disabled={!!downloading}
          onClick={() => handleImport(id)}
        >
          <Upload className="h-3.5 w-3.5" />
          {t('importFromFolder')}
        </Button>
      </div>
    );
    return (
      <SherpaModelRow
        key={id}
        icon={Icon}
        name={t(`engines.funasr.models.${id}.name`)}
        desc={t(`engines.funasr.models.${id}.desc`)}
        installed={installed}
        busy={isBusy}
        progressPercent={pct}
        trailing={trailing}
      />
    );
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-baseline gap-2 px-1">
          <Mic className="h-4 w-4 self-center text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t('engines.funasr.modelsTitle')}
          </h3>
        </div>
        <Card>
          <CardContent className="space-y-2 p-2">
            {ASR_MODELS.map((id) => renderRow(id, Mic))}
          </CardContent>
        </Card>
      </section>

      <AlertDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
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
              onClick={confirmDelete}
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

export default FunasrModelSection;
