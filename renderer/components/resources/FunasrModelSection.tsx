import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { CheckCircle2, Download, Trash2, X, Mic, Waves } from 'lucide-react';
import { toast } from 'sonner';

type FunasrModelId = 'sensevoice-small' | 'paraformer-zh' | 'silero-vad';

interface FunasrModelStatus {
  baseReady: boolean;
  engineInstalled: boolean;
  ready: boolean;
  models: { id: FunasrModelId; installed: boolean }[];
}

const ASR_MODELS: FunasrModelId[] = ['sensevoice-small', 'paraformer-zh'];
const VAD_MODEL: FunasrModelId = 'silero-vad';

const FunasrModelSection: React.FC<{ onUpdate?: () => void }> = ({
  onUpdate,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [status, setStatus] = useState<FunasrModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [downloading, setDownloading] = useState<FunasrModelId | null>(null);

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
        source: 'hf-mirror',
      });
      if (r?.success) {
        await load();
        onUpdate?.();
      } else {
        toast.error(
          r?.error === 'anotherDownloadInProgress'
            ? t('engines.funasr.anotherDownload')
            : r?.error || 'Failed to download model',
        );
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(null);
      setProgress((prev) => ({ ...prev, [`funasr:${id}`]: 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(null);
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

  const renderRow = (id: FunasrModelId, Icon: typeof Mic) => {
    const installed = isInstalled(id);
    const isBusy = downloading === id;
    const pct = Math.round((progress[`funasr:${id}`] ?? 0) * 100);
    return (
      <div
        key={id}
        className="flex items-center justify-between gap-3 rounded-lg border border-muted p-3"
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              {t(`engines.funasr.models.${id}.name`)}
              {installed && (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`engines.funasr.models.${id}.desc`)}
            </p>
            {isBusy && (
              <div className="mt-1.5 w-40">
                <Progress value={pct} />
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0">
          {isBusy ? (
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
              onClick={() => handleDelete(id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('engines.funasr.modelDelete')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={!!downloading}
              onClick={() => handleDownload(id)}
            >
              <Download className="h-3.5 w-3.5" />
              {t('engines.funasr.modelDownload')}
            </Button>
          )}
        </div>
      </div>
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
      <section className="space-y-2">
        <div className="flex items-baseline gap-2 px-1">
          <Waves className="h-4 w-4 self-center text-muted-foreground" />
          <h3 className="text-sm font-semibold">VAD</h3>
          <Badge variant="outline" className="text-[10px]">
            {t('engines.funasr.needModelsHint')}
          </Badge>
        </div>
        <Card>
          <CardContent className="p-2">
            {renderRow(VAD_MODEL, Waves)}
          </CardContent>
        </Card>
      </section>
    </div>
  );
};

export default FunasrModelSection;
