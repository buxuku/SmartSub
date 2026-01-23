import React, { useState, useMemo } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Copy, Check, Download, ExternalLink } from 'lucide-react';
import { openUrl } from 'lib/utils';
import packageInfo from '../../package.json';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: string;
  releaseNotes: string;
}

// 解析 releaseNotes，提取 "下载" 之前的内容
function parseReleaseNotes(html: string): string {
  if (!html) return '';

  // 查找 "下载" 或 "Download" 标题的位置
  const downloadIndex = html.indexOf('<h2>下载');
  if (downloadIndex !== -1) {
    return html.substring(0, downloadIndex).trim();
  }

  const downloadIndexEn = html.indexOf('<h2>Download');
  if (downloadIndexEn !== -1) {
    return html.substring(0, downloadIndexEn).trim();
  }

  return html;
}

// 检测是否为 Mac 平台
function isMacPlatform(): boolean {
  if (typeof navigator !== 'undefined') {
    return navigator.userAgent.includes('Mac');
  }
  return false;
}

export function UpdateDialog({
  open,
  onOpenChange,
  version,
  releaseNotes,
}: UpdateDialogProps) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const isMac = useMemo(() => isMacPlatform(), []);
  const parsedReleaseNotes = useMemo(
    () => parseReleaseNotes(releaseNotes),
    [releaseNotes],
  );

  const brewCommand = 'brew upgrade --cask smartsub';

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(brewCommand);
      setCopied(true);
      toast.success(t('copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy command:', error);
      toast.error(t('copyFailed'));
    }
  };

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const result = await window?.ipc?.invoke('download-update');
      if (result?.success) {
        if (result.manualDownload) {
          // Mac 平台会打开 GitHub 页面
          onOpenChange(false);
        } else {
          // Windows 平台开始下载
          toast.success(t('downloadingUpdate'));
          onOpenChange(false);
        }
      } else if (result?.error) {
        toast.error(t('updateDownloadError'), {
          description: result.error,
        });
      }
    } catch (error) {
      console.error('Failed to download update:', error);
      toast.error(t('updateDownloadError'));
    } finally {
      setIsDownloading(false);
    }
  };

  const handleViewOnGitHub = () => {
    const releaseUrl = `https://github.com/buxuku/SmartSub/releases/tag/v${version}`;
    openUrl(releaseUrl);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('updateDialogTitle')}</DialogTitle>
          <DialogDescription>
            {t('currentVersion')}: v{packageInfo.version} → {t('latestVersion')}
            : v{version}
          </DialogDescription>
        </DialogHeader>

        {/* Release Notes */}
        {parsedReleaseNotes && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t('releaseNotes')}</h4>
            <ScrollArea className="h-[200px] rounded-md border p-4">
              <div
                className="prose prose-sm dark:prose-invert max-w-none
                  [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2
                  [&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-3 [&_h3]:mb-1
                  [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-2
                  [&_li]:text-sm [&_li]:my-1
                  [&_a]:text-primary [&_a]:underline
                  [&_p]:text-sm [&_p]:my-1"
                dangerouslySetInnerHTML={{ __html: parsedReleaseNotes }}
              />
            </ScrollArea>
          </div>
        )}

        {/* Platform-specific update section */}
        <div className="space-y-3 pt-2">
          {isMac ? (
            // Mac Platform: Show brew command
            <div className="space-y-2">
              <h4 className="text-sm font-medium">{t('updateViaHomebrew')}</h4>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono">
                  {brewCommand}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyCommand}
                  className="shrink-0"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          ) : (
            // Windows Platform: Show download button
            <Button
              className="w-full"
              onClick={handleDownload}
              disabled={isDownloading}
            >
              <Download className="mr-2 h-4 w-4" />
              {isDownloading ? t('downloadingUpdate') : t('downloadUpdate')}
            </Button>
          )}

          {/* View on GitHub link */}
          <Button
            variant="outline"
            className="w-full"
            onClick={handleViewOnGitHub}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            {t('viewOnGitHub')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
