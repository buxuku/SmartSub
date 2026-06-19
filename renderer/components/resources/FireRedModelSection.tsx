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

type FireRedModelId = 'fire-red-asr-large-zh-en';

/** fireRed 模型下载源（与主进程 FireRedModelSource 一致）：国内优先 ModelScope。 */
type FireRedModelSource = 'modelscope' | 'ghproxy' | 'github';
const FIRERED_MODEL_SOURCES: FireRedModelSource[] = [
  'modelscope',
  'ghproxy',
  'github',
];
const FIRERED_SOURCE_STORAGE_KEY = 'fireRedModelDownloadSource';

function readFireRedModelSource(): FireRedModelSource {
  if (typeof window === 'undefined') return 'modelscope';
  const v = window.localStorage.getItem(FIRERED_SOURCE_STORAGE_KEY);
  return v === 'ghproxy' || v === 'github' || v === 'modelscope'
    ? v
    : 'modelscope';
}

interface FireRedModelStatus {
  engineInstalled: boolean;
  vadInstalled: boolean;
  ready: boolean;
  models: { id: FireRedModelId; installed: boolean }[];
}

const FireRedModelSection: React.FC<{ onUpdate?: () => void }> = ({
  onUpdate,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [status, setStatus] = useState<FireRedModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [source, setSource] = useState<FireRedModelSource>('modelscope');

  useEffect(() => {
    setSource(readFireRedModelSource());
  }, []);

  const handleSelectSource = useCallback((s: FireRedModelSource) => {
    setSource(s);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(FIRERED_SOURCE_STORAGE_KEY, s);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('getFireRedModelStatus');
      if (r?.success) setStatus(r as FireRedModelStatus);
    } catch {
      // 保持上次状态
    }
  }, []);

  useEffect(() => {
    load();
    const isFireRedKey = (key: unknown): key is string =>
      typeof key === 'string' && key.startsWith('firered:');

    const unsub = window?.ipc?.on(
      'downloadProgress',
      (key: string, value: number) => {
        if (!isFireRedKey(key)) return;
        setProgress((prev) => ({ ...prev, [key]: value }));
        if (value >= 1) {
          void load();
          onUpdate?.();
        }
      },
    );
    const unsubDetail = window?.ipc?.on(
      'modelDownloadDetail',
      (key: string, detail: { status?: string }) => {
        if (!isFireRedKey(key)) return;
        setPhase((prev) => ({ ...prev, [key]: detail?.status ?? '' }));
      },
    );
    return () => {
      unsub?.();
      unsubDetail?.();
    };
  }, [load, onUpdate]);

  const fireRedInstalled =
    status?.models.find((m) => m.id === 'fire-red-asr-large-zh-en')
      ?.installed ?? false;

  // 下载源在「点击下载时」于气泡内选择（与各引擎统一）。
  const sourceConfig: DownloadSourceConfig = {
    value: source,
    options: FIRERED_MODEL_SOURCES.map((s) => ({
      value: s,
      label: t(`engines.fireRedAsr.modelSources.${s}`),
    })),
    onChange: (s) => handleSelectSource(s as FireRedModelSource),
    label: t('engines.fireRedAsr.downloadSource'),
    confirmLabel: commonT('startDownload'),
    hint: t(`engines.fireRedAsr.modelSourceHint.${source}`),
    getCopyUrl: (s) =>
      resolveModelDownloadUrl('firered', s, 'fire-red-asr-large-zh-en'),
  };

  const doDownloadFireRed = async () => {
    setShowConfirm(false);
    setDownloading('fire-red-asr-large-zh-en');
    try {
      const r = await window?.ipc?.invoke('downloadFireRedModel', {
        model: 'fire-red-asr-large-zh-en',
        source,
      });
      if (r?.success) {
        await load();
        onUpdate?.();
      } else {
        toast.error(
          r?.error === 'anotherDownloadInProgress'
            ? t('engines.fireRedAsr.anotherDownload')
            : r?.error || 'Failed to download model',
        );
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(null);
      setProgress((prev) => ({
        ...prev,
        'firered:fire-red-asr-large-zh-en': 0,
      }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(null);
  };

  const handleImportFireRed = async () => {
    const o = await importModelFromFolder(
      'fireRedAsr',
      'fire-red-asr-large-zh-en',
    );
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

  const handleDeleteFireRed = async () => {
    setShowDeleteConfirm(false);
    const r = await window?.ipc?.invoke(
      'deleteFireRedModel',
      'fire-red-asr-large-zh-en',
    );
    if (r?.success) {
      await load();
      onUpdate?.();
    } else {
      toast.error(r?.error || 'Failed to delete model');
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-baseline gap-2 px-1">
          <Mic className="h-4 w-4 self-center text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t('engines.fireRedAsr.modelsTitle')}
          </h3>
        </div>
        <Card>
          <CardContent className="space-y-2 p-2">
            <SherpaModelRow
              icon={Mic}
              name={t(
                'engines.fireRedAsr.models.fire-red-asr-large-zh-en.name',
              )}
              desc={t(
                'engines.fireRedAsr.models.fire-red-asr-large-zh-en.desc',
              )}
              installed={fireRedInstalled}
              busy={downloading === 'fire-red-asr-large-zh-en'}
              progressPercent={Math.round(
                (progress['firered:fire-red-asr-large-zh-en'] ?? 0) * 100,
              )}
              phaseText={
                phase['firered:fire-red-asr-large-zh-en'] === 'extracting'
                  ? t('engines.fireRedAsr.extracting')
                  : undefined
              }
              progressWidthClass="w-44"
              trailing={
                downloading === 'fire-red-asr-large-zh-en' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground"
                    onClick={handleCancel}
                  >
                    <X className="h-3.5 w-3.5" />
                    {commonT('cancel')}
                  </Button>
                ) : fireRedInstalled ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground hover:text-destructive"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('engines.fireRedAsr.modelDelete')}
                  </Button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <DownloadSourcePopover
                      open={showConfirm}
                      onOpenChange={setShowConfirm}
                      config={sourceConfig}
                      onConfirm={doDownloadFireRed}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={!!downloading}
                        onClick={() => setShowConfirm(true)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t('engines.fireRedAsr.modelDownload')}
                      </Button>
                    </DownloadSourcePopover>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-muted-foreground"
                      disabled={!!downloading}
                      onClick={handleImportFireRed}
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
              onClick={handleDeleteFireRed}
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

export default FireRedModelSection;
