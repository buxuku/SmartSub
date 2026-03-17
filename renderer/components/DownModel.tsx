import React, { useEffect, useRef, useCallback, FC, ReactNode } from 'react';

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
      }
    } catch (error) {
      console.error('Download model failed:', error);
      setLoading(false);
    }
  }, [modelName, downSource, needsCoreML, globalDownloading]);

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
