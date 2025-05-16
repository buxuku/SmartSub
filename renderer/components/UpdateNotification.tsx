import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { Download, X } from 'lucide-react';

type UpdateStatus = {
  status:
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  version?: string;
  releaseNotes?: string;
  progress?: number;
  error?: string;
};

export function UpdateNotification() {
  const { t } = useTranslation('common');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [showProgressIndicator, setShowProgressIndicator] = useState(false);

  useEffect(() => {
    // 监听来自主进程的更新状态消息
    const removeListener = window?.ipc?.on(
      'update-status',
      (status: UpdateStatus) => {
        console.log('Update status:', status);
        setUpdateStatus(status);

        // 当开始下载更新时，显示进度指示器
        if (status.status === 'downloading') {
          setShowProgressIndicator(true);
        }

        // 当下载结束（完成或错误）时，隐藏进度指示器
        if (status.status === 'downloaded' || status.status === 'error') {
          setShowProgressIndicator(false);
        }

        // 当更新下载完成时，显示通知
        if (status.status === 'downloaded') {
          toast(t('updateReady'), {
            description: t('updateReadyDesc', { version: status.version }),
            action: {
              label: t('installNow'),
              onClick: () => installUpdate(),
            },
          });
        }

        // 当更新出错时，显示通知
        if (status.status === 'error') {
          toast.error(t('updateError'), {
            description: status.error,
          });
        }
      },
    );

    // 组件卸载时移除监听器
    return () => {
      if (removeListener) removeListener();
    };
  }, [t]);

  // 安装更新
  const installUpdate = async () => {
    try {
      await window?.ipc?.invoke('install-update');
    } catch (error) {
      console.error('Error installing update:', error);
      toast.error(t('updateInstallError'), {
        description: error.message,
      });
    }
  };

  return (
    <>
      {/* 下载进度指示器 */}
      {showProgressIndicator && updateStatus?.status === 'downloading' && (
        <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg bg-background p-4 shadow-lg border border-accent animate-in slide-in-from-bottom-5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Download className="size-4 text-primary animate-pulse" />
              <span className="text-sm font-medium">
                {t('downloadingUpdate')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                {Math.round(updateStatus.progress || 0)}%
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 p-0 hover:bg-accent hover:text-accent-foreground"
                onClick={() => setShowProgressIndicator(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <Progress value={updateStatus.progress} className="h-2" />
          <div className="mt-2 text-xs text-muted-foreground">
            {t('downloadingUpdateDesc', { version: updateStatus.version })}
          </div>
        </div>
      )}
    </>
  );
}
