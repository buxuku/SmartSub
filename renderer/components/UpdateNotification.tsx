import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { AlertCircle, Download, RefreshCw } from 'lucide-react';
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

type UpdateStatus = {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  releaseNotes?: string;
  progress?: number;
  error?: string;
};

export function UpdateNotification() {
  const { t } = useTranslation('common');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);

  useEffect(() => {
    // 监听来自主进程的更新状态消息
    const removeListener = window?.ipc?.on('update-status', (status: UpdateStatus) => {
      console.log('Update status:', status);
      setUpdateStatus(status);
      
      // 当有新版本可用时，显示对话框
      if (status.status === 'available') {
        setShowUpdateDialog(true);
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
    });

    // 组件卸载时移除监听器
    return () => {
      if (removeListener) removeListener();
    };
  }, [t]);

  // 检查更新
  const checkForUpdates = async () => {
    try {
      await window?.ipc?.invoke('check-for-updates');
    } catch (error) {
      console.error('Error checking for updates:', error);
      toast.error(t('updateCheckError'), {
        description: error.message,
      });
    }
  };

  // 下载更新
  const downloadUpdate = async () => {
    try {
      setShowUpdateDialog(false);
      await window?.ipc?.invoke('download-update');
    } catch (error) {
      console.error('Error downloading update:', error);
      toast.error(t('updateDownloadError'), {
        description: error.message,
      });
    }
  };

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
      {/* 更新检查按钮 */}
      <Button
        variant="ghost"
        size="icon"
        onClick={checkForUpdates}
        className="rounded-lg"
        aria-label={t('checkForUpdates')}
      >
        <RefreshCw className={`size-5 ${updateStatus?.status === 'checking' ? 'animate-spin' : ''}`} />
      </Button>

      {/* 下载进度指示器 */}
      {updateStatus?.status === 'downloading' && (
        <div className="fixed bottom-4 right-4 z-50 w-64 rounded-lg bg-background p-4 shadow-lg border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">{t('downloadingUpdate')}</span>
            <span className="text-sm">{Math.round(updateStatus.progress || 0)}%</span>
          </div>
          <Progress value={updateStatus.progress} className="h-2" />
        </div>
      )}

      {/* 更新可用对话框 */}
      <AlertDialog open={showUpdateDialog} onOpenChange={setShowUpdateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('newVersionAvailable')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('newVersionDesc', { version: updateStatus?.version })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('later')}</AlertDialogCancel>
            <AlertDialogAction onClick={downloadUpdate}>
              <Download className="mr-2 h-4 w-4" />
              {t('downloadNow')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}