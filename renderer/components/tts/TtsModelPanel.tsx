/**
 * 「配音服务」右栏：单个本地 TTS 模型的管理面板
 * （下载/进度/取消/删除/导入/打开目录，进度 key tts:<id>）。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Download,
  FolderOpen,
  HardDriveUpload,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { TtsModelItem } from './useTtsModels';

function fmtBytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

export default function TtsModelPanel({
  model,
  onUpdate,
}: {
  model: TtsModelItem;
  onUpdate: () => void;
}) {
  const { t } = useTranslation('resources');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const key = `tts:${model.id}`;
    const unsubProgress = window?.ipc?.on(
      'downloadProgress',
      (k: string, ratio: number) => {
        if (k !== key) return;
        setDownloading((ratio as number) < 1);
        setProgress(Math.round((ratio as number) * 100));
        if ((ratio as number) >= 1) {
          setExtracting(false);
          onUpdate();
        }
      },
    );
    const unsubDetail = window?.ipc?.on(
      'modelDownloadDetail',
      (k: string, detail: { status?: string }) => {
        if (k !== key) return;
        setExtracting(detail?.status === 'extracting');
      },
    );
    return () => {
      unsubProgress?.();
      unsubDetail?.();
    };
  }, [model.id, onUpdate]);

  const handleDownload = async () => {
    setDownloading(true);
    setProgress(0);
    try {
      const res = await window?.ipc?.invoke('downloadTtsModel', {
        model: model.id,
      });
      if (!res?.success) {
        toast.error(
          res?.error === 'anotherDownloadInProgress'
            ? t('dubbingBlock.anotherDownload')
            : res?.error || t('dubbingBlock.downloadFailed'),
        );
      }
    } finally {
      setDownloading(false);
      setExtracting(false);
      onUpdate();
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(false);
    setExtracting(false);
    onUpdate();
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      const res = await window?.ipc?.invoke('deleteTtsModel', model.id);
      if (!res?.success) toast.error(res?.error || 'delete failed');
    } finally {
      setBusy(false);
      onUpdate();
    }
  };

  const handleImport = async () => {
    setBusy(true);
    try {
      const res = await window?.ipc?.invoke('importModel', {
        engine: 'tts',
        modelId: model.id,
      });
      if (res?.success) {
        toast.success(t('dubbingBlock.importDone'));
      } else if (!res?.canceled) {
        toast.error(
          res?.reason === 'invalid-layout'
            ? t('dubbingBlock.importInvalid', {
                missing: (res?.missing ?? []).join(', '),
              })
            : res?.error || t('dubbingBlock.importFailed'),
        );
      }
    } finally {
      setBusy(false);
      onUpdate();
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {model.cloneOnly
            ? t('dubbingBlock.cloneModelIntro')
            : t('dubbingBlock.modelsIntro')}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[11px]">
          {model.languages.join(' / ')}
        </Badge>
        <Badge variant="outline" className="text-[11px]">
          {model.cloneOnly
            ? t('dubbingBlock.clonePool')
            : t('dubbingBlock.voiceCount', { count: model.voices.length })}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {fmtBytes(model.approxInstallBytes)} · {model.sampleRate / 1000}kHz
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              window?.ipc?.invoke('openModelsFolder', { pathType: 'tts' })
            }
          >
            <FolderOpen className="h-4 w-4" />
            {t('dubbingBlock.openModelsFolder')}
          </Button>
        </div>
      </div>

      {downloading ? (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <Progress value={progress} className="h-2" />
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {extracting ? t('dubbingBlock.extracting') : `${progress}%`}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1"
            onClick={handleCancel}
          >
            <X className="h-3.5 w-3.5" />
            {t('dubbingBlock.cancelDownload')}
          </Button>
        </div>
      ) : model.installed ? (
        <div className="flex items-center gap-2 rounded-lg border p-3">
          <Badge variant="outline" className="border-success/40 text-success">
            {t('dubbingBlock.installed')}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={handleDelete}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {t('dubbingBlock.deleteModel')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
          <Button size="sm" className="gap-1" onClick={handleDownload}>
            <Download className="h-3.5 w-3.5" />
            {t('dubbingBlock.download')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={busy}
            onClick={handleImport}
          >
            <HardDriveUpload className="h-3.5 w-3.5" />
            {t('dubbingBlock.import')}
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            {t('dubbingBlock.downloadSourceHint')}
          </p>
        </div>
      )}
    </div>
  );
}
