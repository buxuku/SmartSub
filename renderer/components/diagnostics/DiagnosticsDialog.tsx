import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { FileArchive, FolderOpen, Github } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatBytes } from '@/components/tasks/stageUtils';
import { openUrl } from 'lib/utils';
import {
  isDiagnosticsExported,
  type DiagnosticsExported,
  type DiagnosticsExportResult,
  type DiagnosticsPreview,
} from '../../../types/diagnostics';

interface DiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 导出诊断包：先列出包里会有什么，再由用户决定是否附带原始崩溃转储。
 * 不会自动上传；导出后可以在文件夹中显示，或打开预填了环境摘要的 GitHub issue 页。
 */
export function DiagnosticsDialog({
  open,
  onOpenChange,
}: DiagnosticsDialogProps) {
  const { t } = useTranslation('common');
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null);
  const [includeRawDumps, setIncludeRawDumps] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<DiagnosticsExported | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都重新读取清单并清掉上一次的结果
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setIncludeRawDumps(false);
    setExported(null);
    setError(null);
    window.ipc
      .invoke('diagnostics:preview')
      .then((result: DiagnosticsPreview) => {
        if (!cancelled) setPreview(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const result: DiagnosticsExportResult = await window.ipc.invoke(
        'diagnostics:export',
        { includeRawDumps },
      );
      if (isDiagnosticsExported(result)) {
        setExported(result);
      } else if (!result.canceled) {
        setError(result.error ?? 'unknown');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [includeRawDumps]);

  const handleReveal = useCallback(() => {
    if (exported)
      void window.ipc.invoke('diagnostics:reveal', exported.filePath);
  }, [exported]);

  const handleReportIssue = useCallback(async () => {
    const url: string = await window.ipc.invoke('diagnostics:issue-url');
    if (url) openUrl(url);
  }, []);

  const dumpCount = preview?.dumps.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileArchive className="h-5 w-5" />
            {t('diagnostics.title')}
          </DialogTitle>
          <DialogDescription>{t('diagnostics.description')}</DialogDescription>
        </DialogHeader>

        {exported ? (
          <div className="space-y-3 text-sm" data-testid="diagnostics-done">
            <p className="font-medium">{t('diagnostics.doneTitle')}</p>
            <p className="text-muted-foreground">
              {t('diagnostics.doneDesc', { size: formatBytes(exported.bytes) })}
            </p>
            {exported.warnings.length > 0 && (
              <p className="text-warning">
                {t('diagnostics.warnings', { count: exported.warnings.length })}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <div className="font-medium">
                {t('diagnostics.contentsTitle')}
              </div>
              {preview ? (
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>
                    {preview.logDays > 0
                      ? t('diagnostics.logs', {
                          count: preview.logDays,
                          size: formatBytes(preview.logBytes),
                        })
                      : t('diagnostics.logsNone')}
                  </li>
                  <li>
                    {preview.crashEventCount > 0
                      ? t('diagnostics.events', {
                          count: preview.crashEventCount,
                        })
                      : t('diagnostics.eventsNone')}
                  </li>
                  <li>
                    {dumpCount > 0
                      ? t('diagnostics.dumpSummaries', { count: dumpCount })
                      : t('diagnostics.dumpSummariesNone')}
                  </li>
                  <li>{t('diagnostics.system')}</li>
                  <li>{t('diagnostics.settings')}</li>
                </ul>
              ) : (
                !error && (
                  <p className="text-muted-foreground">
                    {t('diagnostics.loading')}
                  </p>
                )
              )}
            </div>

            {preview && !preview.crashReporterEnabled && (
              <p className="text-warning">
                {t('diagnostics.crashReporterOff')}
              </p>
            )}

            {dumpCount > 0 && (
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={includeRawDumps}
                  onCheckedChange={setIncludeRawDumps}
                  aria-label={t('diagnostics.rawDumps', {
                    count: dumpCount,
                    size: formatBytes(preview?.dumpBytes),
                  })}
                />
                <span className="space-y-0.5">
                  <span className="block">
                    {t('diagnostics.rawDumps', {
                      count: dumpCount,
                      size: formatBytes(preview?.dumpBytes),
                    })}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('diagnostics.rawDumpsWarning')}
                  </span>
                </span>
              </label>
            )}

            <p className="text-xs text-muted-foreground">
              {t('diagnostics.privacy')}
            </p>

            {error && (
              <p className="text-destructive" role="alert">
                {t('diagnostics.failed', { error })}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {exported ? (
            <>
              <Button variant="outline" size="sm" onClick={handleReveal}>
                <FolderOpen className="mr-1.5 h-4 w-4" />
                {t('diagnostics.reveal')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleReportIssue}>
                <Github className="mr-1.5 h-4 w-4" />
                {t('diagnostics.reportIssue')}
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                {t('diagnostics.close')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleExport}
                disabled={!preview || exporting}
              >
                {exporting
                  ? t('diagnostics.exporting')
                  : t('diagnostics.export')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
