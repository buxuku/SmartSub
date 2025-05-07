import React, { useEffect, FC, ReactNode } from 'react';

interface IProps {
  modelName: string;
  callBack: () => void;
  downSource: string;
  children: ReactNode;
  needsCoreML?: boolean;
}

const DownModel: FC<IProps> = ({
  modelName,
  callBack,
  downSource,
  children,
  needsCoreML = true,
}) => {
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  useEffect(() => {
    // 监听下载进度事件
    const handleProgress = (model: string, progressValue: number) => {
      if (model?.toLowerCase() === modelName?.toLowerCase()) {
        setProgress(progressValue);
        setLoading(0.0 <= progressValue && progressValue < 1.0);
        if (progressValue >= 1.0) {
          callBack();
        }
      }
    };

    window?.ipc?.on('downloadProgress', handleProgress);
  }, [modelName, callBack]);

  const handleDownModel = async () => {
    try {
      setLoading(true);
      console.log(needsCoreML, modelName, 'needsCoreML2');
      await window?.ipc?.invoke('downloadModel', {
        model: modelName,
        source: downSource,
        needsCoreML,
      });
    } catch (error) {
      console.error('下载模型失败:', error);
      setLoading(false);
    }
  };

  return (
    <span className="inline-block">
      {React.isValidElement<{
        loading?: boolean;
        progress?: number;
        handleDownModel?: () => void;
      }>(children)
        ? React.cloneElement(children, {
            loading,
            progress,
            handleDownModel,
          })
        : children}
    </span>
  );
};

export default DownModel;
