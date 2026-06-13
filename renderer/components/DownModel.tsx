import React, { useEffect, useRef, useCallback, FC, ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';

interface DownloadDetail {
  status: string;
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  error?: string;
}

interface IProps {
  modelName: string;
  callBack: () => void;
  downSource: string;
  children: ReactNode;
  needsCoreML?: boolean;
  globalDownloading?: boolean;
}

const DownModel: FC<IProps> = ({
  modelName,
  callBack,
  downSource,
  children,
  needsCoreML = true,
  globalDownloading = false,
}) => {
  const { t } = useTranslation('common');
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [detail, setDetail] = React.useState<DownloadDetail | null>(null);
  const callBackRef = useRef(callBack);
  callBackRef.current = callBack;

  useEffect(() => {
    const handleProgress = (model: string, progressValue: number) => {
      if (model?.toLowerCase() === modelName?.toLowerCase()) {
        setProgress(progressValue);
      }
    };

    const handleDetail = (model: string, detailData: DownloadDetail) => {
      if (model?.toLowerCase() === modelName?.toLowerCase()) {
        setDetail(detailData);
      }
    };

    const unsubProgress = window?.ipc?.on('downloadProgress', handleProgress);
    const unsubDetail = window?.ipc?.on('modelDownloadDetail', handleDetail);

    return () => {
      unsubProgress?.();
      unsubDetail?.();
    };
  }, [modelName]);

  const handleDownModel = useCallback(async () => {
    if (globalDownloading) return;
    try {
      setLoading(true);
      setProgress(0);
      setDetail(null);
      const result = await window?.ipc?.invoke('downloadModel', {
        model: modelName,
        source: downSource,
        needsCoreML,
      });
      setLoading(false);
      if (result?.success) {
        setProgress(1);
        callBackRef.current();
      } else if (result?.error === 'anotherDownloadInProgress') {
        toast.error(t('downloadBusy'));
      } else if (
        result?.error &&
        !String(result.error).toLowerCase().includes('cancelled')
      ) {
        // 用户主动取消时 download promise 以 "Download cancelled" reject，
        // 主进程同样返回 success:false，但不应视为失败提示
        toast.error(t('downloadFailedToast', { error: result.error }));
      }
    } catch (error) {
      console.error('Download model failed:', error);
      setLoading(false);
    }
  }, [modelName, downSource, needsCoreML, globalDownloading, t]);

  const isDisabled = globalDownloading && !loading;

  return (
    <span className="inline-block">
      {React.isValidElement<{
        loading?: boolean;
        progress?: number;
        detail?: DownloadDetail | null;
        handleDownModel?: () => void;
        disabled?: boolean;
      }>(children)
        ? React.cloneElement(children, {
            loading,
            progress,
            detail,
            handleDownModel,
            disabled: isDisabled,
          })
        : children}
    </span>
  );
};

export default DownModel;
