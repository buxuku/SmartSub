import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
import { CheckCircle2, Download, Trash2, X, Mic, Waves } from 'lucide-react';
import { toast } from 'sonner';

type QwenModelId = 'qwen3-asr-0.6b';
const QWEN_MODEL_SIZE = '0.95GB';

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
      typeof key === 'string' &&
      (key.startsWith('qwen:') || key === 'funasr:silero-vad');

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
  const vadInstalled = status?.vadInstalled ?? false;

  const doDownloadQwen = async () => {
    setShowConfirm(false);
    setDownloading('qwen3-asr-0.6b');
    try {
      const r = await window?.ipc?.invoke('downloadQwenModel', {
        model: 'qwen3-asr-0.6b',
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

  const handleDownloadVad = async () => {
    setDownloading('silero-vad');
    try {
      const r = await window?.ipc?.invoke('downloadFunasrModel', {
        model: 'silero-vad',
        source: 'hf-mirror',
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
      setProgress((prev) => ({ ...prev, 'funasr:silero-vad': 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(null);
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
            <div className="flex items-center justify-between gap-3 rounded-lg border border-muted p-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <Mic className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    {t('engines.qwen.models.qwen3-asr-0.6b.name')}
                    {qwenInstalled && (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('engines.qwen.models.qwen3-asr-0.6b.desc')}
                  </p>
                  {downloading === 'qwen3-asr-0.6b' && (
                    <div className="mt-1.5 w-44">
                      <Progress
                        value={Math.round(
                          (progress['qwen:qwen3-asr-0.6b'] ?? 0) * 100,
                        )}
                      />
                      {phase['qwen:qwen3-asr-0.6b'] === 'extracting' && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {t('engines.qwen.extracting')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="shrink-0">
                {downloading === 'qwen3-asr-0.6b' ? (
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
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-2">
        <div className="flex items-baseline gap-2 px-1">
          <Waves className="h-4 w-4 self-center text-muted-foreground" />
          <h3 className="text-sm font-semibold">VAD</h3>
          <Badge variant="outline" className="text-[10px]">
            {t('engines.qwen.needModelsHint')}
          </Badge>
        </div>
        <Card>
          <CardContent className="p-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-muted p-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <Waves className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    {t('engines.funasr.models.silero-vad.name')}
                    {vadInstalled && (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('engines.funasr.models.silero-vad.desc')}
                  </p>
                  {downloading === 'silero-vad' && (
                    <div className="mt-1.5 w-40">
                      <Progress
                        value={Math.round(
                          (progress['funasr:silero-vad'] ?? 0) * 100,
                        )}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div className="shrink-0">
                {downloading === 'silero-vad' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground"
                    onClick={handleCancel}
                  >
                    <X className="h-3.5 w-3.5" />
                    {commonT('cancel')}
                  </Button>
                ) : vadInstalled ? (
                  <Badge
                    variant="outline"
                    className="gap-1 border-success/40 text-success"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t('engines.funasr.installed')}
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={!!downloading}
                    onClick={handleDownloadVad}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t('engines.qwen.modelDownload')}
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('engines.qwen.modelDownload')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.qwen.modelDownloadConfirm', {
                size: QWEN_MODEL_SIZE,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction className="gap-1.5" onClick={doDownloadQwen}>
              <Download className="h-4 w-4" />
              {t('engines.qwen.modelDownload')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
