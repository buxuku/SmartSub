import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import DownloadSourceSelector from '@/components/resources/engines/DownloadSourceSelector';
import { Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'next-i18next';

interface ModelQuickDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stagedFilesCount: number;
  onSuccess: () => void | Promise<void>;
}

export default function ModelQuickDownloadDialog({
  open,
  onOpenChange,
  stagedFilesCount,
  onSuccess,
}: ModelQuickDownloadDialogProps) {
  const { t } = useTranslation('launchpad');
  const [downloading, setDownloading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState('hf-mirror');
  const requestRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const cancellingRef = useRef(false);

  useEffect(() => {
    activeRef.current = open;
    setDownloading(false);
    setCancelling(false);
    setProgress(0);
    setError(null);
    cancellingRef.current = false;
    if (!open) return;

    const unsubscribe = window.ipc.on(
      'downloadProgress',
      (model: string, value: number) => {
        if (requestRef.current && model === 'base' && Number.isFinite(value)) {
          setProgress(Math.max(0, Math.min(100, Math.round(value * 100))));
        }
      },
    );
    return () => {
      activeRef.current = false;
      unsubscribe?.();
      const requestId = requestRef.current;
      requestRef.current = null;
      if (requestId)
        void window.ipc
          .invoke('cancelModelDownload', { requestId })
          .catch(() => {});
    };
  }, [open]);

  const handleStartDownload = async () => {
    if (requestRef.current || !activeRef.current) return;
    const requestId = uuidv4();
    requestRef.current = requestId;
    setDownloading(true);
    setProgress(0);
    setError(null);
    try {
      const result = await window.ipc.invoke('downloadModel', {
        model: 'base',
        source,
        needsCoreML: false,
        requestId,
      });
      if (
        !activeRef.current ||
        requestRef.current !== requestId ||
        cancellingRef.current
      )
        return;
      if (result?.success !== true) {
        throw new Error(
          result?.error === 'anotherDownloadInProgress'
            ? t('quickDownload.busy')
            : result?.error || t('quickDownload.failed'),
        );
      }
      const info = await window.ipc.invoke('getSystemInfo', null);
      if (
        !activeRef.current ||
        requestRef.current !== requestId ||
        cancellingRef.current
      )
        return;
      if (!info?.modelsInstalled?.includes('base'))
        throw new Error(t('quickDownload.notInstalled'));
      setProgress(100);
      await onSuccess();
      if (activeRef.current) onOpenChange(false);
    } catch (err) {
      if (
        activeRef.current &&
        requestRef.current === requestId &&
        !cancellingRef.current
      ) {
        setError(
          err instanceof Error ? err.message : t('quickDownload.failed'),
        );
      }
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null;
        if (activeRef.current) setDownloading(false);
      }
    }
  };

  const handleCancel = async () => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    try {
      const requestId = requestRef.current;
      if (requestId)
        await window.ipc.invoke('cancelModelDownload', { requestId });
      requestRef.current = null;
      activeRef.current = false;
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('quickDownload.failed'));
    } finally {
      cancellingRef.current = false;
      if (activeRef.current) setCancelling(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void handleCancel();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('quickDownload.title')}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed pt-1">
            {t('quickDownload.desc', { count: stagedFilesCount })}
          </DialogDescription>
        </DialogHeader>
        {downloading ? (
          <div className="space-y-2 py-3">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {t('quickDownload.downloading', { progress })}
            </span>
            <Progress value={progress} className="h-2" />
          </div>
        ) : (
          <DownloadSourceSelector
            label={t('quickDownload.source')}
            value={source}
            onChange={setSource}
            options={[
              { value: 'hf-mirror', label: t('quickDownload.mirror') },
              { value: 'huggingface', label: 'Hugging Face' },
            ]}
          />
        )}
        {error && (
          <div
            role="alert"
            className="break-words bg-destructive/10 p-3 text-xs text-destructive"
          >
            {error}
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {t('quickDownload.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleStartDownload}
            disabled={downloading || cancelling}
            className="gap-1.5"
          >
            <Download className="h-4 w-4" />
            {t('quickDownload.startDownload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
