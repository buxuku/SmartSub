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

type QwenModelId = 'qwen3-asr-0.6b' | 'qwen3-asr-1.7b';

/** qwen 模型下载源（与主进程 QwenModelSource 一致）：国内优先 ModelScope。 */
type QwenModelSource = 'modelscope' | 'ghproxy' | 'github';
const QWEN_MODEL_SOURCES: QwenModelSource[] = [
  'modelscope',
  'ghproxy',
  'github',
];
const QWEN_MODEL_IDS: QwenModelId[] = ['qwen3-asr-0.6b', 'qwen3-asr-1.7b'];
const QWEN_FALLBACK_SOURCES: Record<QwenModelId, QwenModelSource[]> = {
  'qwen3-asr-0.6b': QWEN_MODEL_SOURCES,
  // sherpa-onnx 暂未发布 1.7B 的 GitHub release 整包。
  'qwen3-asr-1.7b': ['modelscope'],
};
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
  models: {
    id: QwenModelId;
    installed: boolean;
    sources?: QwenModelSource[];
  }[];
}

const QwenModelSection: React.FC<{ onUpdate?: () => void }> = ({
  onUpdate,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [status, setStatus] = useState<QwenModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState<QwenModelId | null>(null);
  const [pickerId, setPickerId] = useState<QwenModelId | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<QwenModelId | null>(
    null,
  );
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

  const isInstalled = (id: QwenModelId) =>
    status?.models.find((m) => m.id === id)?.installed ?? false;

  const supportedSources = (id: QwenModelId): QwenModelSource[] =>
    status?.models.find((m) => m.id === id)?.sources ??
    QWEN_FALLBACK_SOURCES[id];

  const effectiveSource = (id: QwenModelId): QwenModelSource => {
    const supported = supportedSources(id);
    return supported.includes(source) ? source : supported[0];
  };

  // 下载源在「点击下载时」于气泡内选择（与各引擎统一）。
  const sourceConfigFor = (id: QwenModelId): DownloadSourceConfig => {
    const sources = supportedSources(id);
    const selected = effectiveSource(id);
    return {
      value: selected,
      options: sources.map((s) => ({
        value: s,
        label: t(`engines.qwen.modelSources.${s}`),
      })),
      onChange: (s) => handleSelectSource(s as QwenModelSource),
      label: t('engines.qwen.downloadSource'),
      confirmLabel: commonT('startDownload'),
      hint: t(`engines.qwen.modelSourceHint.${selected}`),
      getCopyUrl: (s) => resolveModelDownloadUrl('qwen', s, id),
    };
  };

  const handleDownload = async (id: QwenModelId) => {
    setPickerId(null);
    setDownloading(id);
    try {
      const r = await window?.ipc?.invoke('downloadQwenModel', {
        model: id,
        source: effectiveSource(id),
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
      setProgress((prev) => ({ ...prev, [`qwen:${id}`]: 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(null);
  };

  const handleImport = async (id: QwenModelId) => {
    const o = await importModelFromFolder('qwen', id);
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

  const handleDelete = async (id: QwenModelId) => {
    const r = await window?.ipc?.invoke('deleteQwenModel', id);
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

  const renderRow = (id: QwenModelId) => {
    const installed = isInstalled(id);
    const isBusy = downloading === id;
    const key = `qwen:${id}`;
    const sourceConfig = sourceConfigFor(id);

    return (
      <SherpaModelRow
        key={id}
        icon={Mic}
        name={t(`engines.qwen.models.${id}.name`)}
        desc={t(`engines.qwen.models.${id}.desc`)}
        installed={installed}
        busy={isBusy}
        progressPercent={Math.round((progress[key] ?? 0) * 100)}
        phaseText={
          phase[key] === 'extracting' ? t('engines.qwen.extracting') : undefined
        }
        progressWidthClass="w-44"
        trailing={
          isBusy ? (
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
              {t('engines.qwen.modelDelete')}
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <DownloadSourcePopover
                open={pickerId === id}
                onOpenChange={(open) => setPickerId(open ? id : null)}
                config={sourceConfig}
                onConfirm={() => handleDownload(id)}
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={!!downloading}
                  onClick={() => setPickerId(id)}
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
            {QWEN_MODEL_IDS.map(renderRow)}
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

export default QwenModelSection;
