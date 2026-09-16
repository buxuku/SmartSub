import React, { useState, useEffect } from 'react';
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
import { Download, Loader2, Sparkles, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';

interface ModelQuickDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stagedFilesCount: number;
  onSuccess: () => void;
}

export default function ModelQuickDownloadDialog({
  open,
  onOpenChange,
  stagedFilesCount,
  onSuccess,
}: ModelQuickDownloadDialogProps) {
  const { t } = useTranslation('launchpad');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (!open) {
      setDownloading(false);
      setProgress(0);
      setCompleted(false);
      return;
    }

    const unsubProgress = window?.ipc?.on(
      'downloadProgress',
      (model: string, progressValue: number) => {
        if (typeof progressValue === 'number') {
          setProgress(Math.round(progressValue * 100));
        }
      },
    );

    return () => {
      unsubProgress?.();
    };
  }, [open]);

  const handleStartDownload = async () => {
    try {
      setDownloading(true);
      setProgress(0);

      const result = await window?.ipc?.invoke('downloadModel', {
        model: 'base',
        needsCoreML: false,
      });

      if (result?.success) {
        setProgress(100);
        setCompleted(true);
        toast.success(t('quickDownload.installComplete'));
        setTimeout(() => {
          onOpenChange(false);
          onSuccess();
        }, 1000);
      } else {
        setDownloading(false);
        if (result?.error && !String(result.error).includes('cancelled')) {
          toast.error(result.error);
        }
      }
    } catch (err: any) {
      console.error('Failed to quick download model:', err);
      setDownloading(false);
      toast.error(err?.message || 'Download failed');
    }
  };

  const handleCancel = async () => {
    if (downloading) {
      try {
        await window?.ipc?.invoke('cancelModelDownload');
      } catch {
        /* ignore */
      }
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleCancel();
        } else {
          onOpenChange(true);
        }
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <Sparkles className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-wider">
              SmartSub Pro
            </span>
          </div>
          <DialogTitle>{t('quickDownload.title')}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed pt-1">
            {t('quickDownload.desc', { count: stagedFilesCount })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-3">
          {downloading && (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  {t('quickDownload.downloading', { progress })}
                </span>
                <span className="font-mono font-medium text-foreground">
                  {progress}%
                </span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          {completed && (
            <div className="flex items-center gap-2 rounded-lg bg-success/10 border border-success/20 p-3 text-xs text-success font-medium">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {t('quickDownload.installComplete')}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={completed}
          >
            {t('quickDownload.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleStartDownload}
            disabled={downloading || completed}
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
