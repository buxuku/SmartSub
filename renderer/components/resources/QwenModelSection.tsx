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

type QwenModelId = 'qwen3-asr-0.6b';

/** qwen 模型下载源（与主进程 QwenModelSource 一致）：国内优先 ModelScope。 */
type QwenModelSource = 'modelscope' | 'ghproxy' | 'github';
const QWEN_MODEL_SOURCES: QwenModelSource[] = [
  'modelscope',
  'ghproxy',
  'github',
];
const QWEN_SOURCE_STORAGE_KEY = 'qwenModelDownloadSource';

function readQwenModelSource(): QwenModelSource {
  if (typeof window === 'undefined') return 'modelscope';
  const v = window.localStorage.getItem(QWEN_SOURCE_STORAGE_KEY);
  return v === 'ghproxy' || v === 'github' || v === 'modelscope'
    ? v
    : 'modelscope';
}

interface QwenModelStatus {
  engineInstalled: boolean;
  vadInstalled: boolean;
  ready: boolean;
  models: { id: QwenModelId; installed: boolean }[];
}

const QwenModelSection: React.FC<{ onUpdate?: () => void }> = ({
  onUpdate,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [status, setStatus] = useState<QwenModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [source, setSource] = useState<QwenModelSource>('modelscope');

  useEffect(() => {
    setSource(readQwenModelSource());
  }, []);

  const handleSelectSource = useCallback((s: QwenModelSource) => {
    setSource(s);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(QWEN_SOURCE_STORAGE_KEY, s);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('getQwenModelStatus');
      if (r?.success) setStatus(r as QwenModelStatus);
    } catch {
      // 保持上次状态
    }
  }, []);

  useEffect(() => {
    load();
    const isQwenKey = (key: unknown): key is string =>
      typeof key === 'string' && key.startsWith('qwen:');

    const unsub = window?.ipc?.on(
      'downloadProgress',
      (key: string, value: number) => {
        if (!isQwenKey(key)) return;
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
        if (!isQwenKey(key)) return;
        setPhase((prev) => ({ ...prev, [key]: detail?.status ?? '' }));
      },
    );
    return () => {
      unsub?.();
      unsubDetail?.();
    };
  }, [load, onUpdate]);

  const qwenInstalled =
    status?.models.find((m) => m.id === 'qwen3-asr-0.6b')?.installed ?? false;

  // 下载源在「点击下载时」于气泡内选择（与各引擎统一）。
  const sourceConfig: DownloadSourceConfig = {
    value: source,
    options: QWEN_MODEL_SOURCES.map((s) => ({
      value: s,
      label: t(`engines.qwen.modelSources.${s}`),
    })),
    onChange: (s) => handleSelectSource(s as QwenModelSource),
    label: t('engines.qwen.downloadSource'),
    confirmLabel: commonT('startDownload'),
    hint: t(`engines.qwen.modelSourceHint.${source}`),
    getCopyUrl: (s) => resolveModelDownloadUrl('qwen', s, 'qwen3-asr-0.6b'),
  };

  const doDownloadQwen = async () => {
    setShowConfirm(false);
    setDownloading('qwen3-asr-0.6b');
    try {
      const r = await window?.ipc?.invoke('downloadQwenModel', {
        model: 'qwen3-asr-0.6b',
        source,
      });
      if (r?.success) {
        await load();
        onUpdate?.();
      } else {
        toast.error(
          r?.error === 'anotherDownloadInProgress'
            ? t('engines.qwen.anotherDownload')
            : r?.error || 'Failed to download model',
        );
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(null);
      setProgress((prev) => ({ ...prev, 'qwen:qwen3-asr-0.6b': 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(null);
  };

  const handleImportQwen = async () => {
    const o = await importModelFromFolder('qwen', 'qwen3-asr-0.6b');
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

  const handleDeleteQwen = async () => {
    setShowDeleteConfirm(false);
    const r = await window?.ipc?.invoke('deleteQwenModel', 'qwen3-asr-0.6b');
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
            {t('engines.qwen.modelsTitle')}
          </h3>
        </div>
        <Card>
          <CardContent className="space-y-2 p-2">
            <SherpaModelRow
              icon={Mic}
              name={t('engines.qwen.models.qwen3-asr-0.6b.name')}
              desc={t('engines.qwen.models.qwen3-asr-0.6b.desc')}
              installed={qwenInstalled}
              busy={downloading === 'qwen3-asr-0.6b'}
              progressPercent={Math.round(
                (progress['qwen:qwen3-asr-0.6b'] ?? 0) * 100,
              )}
              phaseText={
                phase['qwen:qwen3-asr-0.6b'] === 'extracting'
                  ? t('engines.qwen.extracting')
                  : undefined
              }
              progressWidthClass="w-44"
              trailing={
                downloading === 'qwen3-asr-0.6b' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground"
                    onClick={handleCancel}
                  >
                    <X className="h-3.5 w-3.5" />
                    {commonT('cancel')}
                  </Button>
                ) : qwenInstalled ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground hover:text-destructive"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('engines.qwen.modelDelete')}
                  </Button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <DownloadSourcePopover
                      open={showConfirm}
                      onOpenChange={setShowConfirm}
                      config={sourceConfig}
                      onConfirm={doDownloadQwen}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={!!downloading}
                        onClick={() => setShowConfirm(true)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t('engines.qwen.modelDownload')}
                      </Button>
                    </DownloadSourcePopover>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-muted-foreground"
                      disabled={!!downloading}
                      onClick={handleImportQwen}
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
              onClick={handleDeleteQwen}
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

export default QwenModelSection;
