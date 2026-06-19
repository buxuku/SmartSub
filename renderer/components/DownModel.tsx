import React, { useEffect, useRef, useCallback, FC, ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import DownloadSourcePopover, {
  useDownloadSource,
} from '@/components/resources/engines/DownloadSourcePopover';

export type ModelDownloadFormat = 'ggml' | 'ct2';

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
  format?: ModelDownloadFormat;
  /** 气泡内「复制链接」：按当前所选源返回本模型可复制的下载链接（不提供则不显示复制）。 */
  getCopyUrl?: (source: string) => string | null | undefined;
}

function getProgressKey(
  modelName: string,
  format: ModelDownloadFormat,
): string {
  return format === 'ct2' ? `ct2:${modelName}` : modelName;
}

// 代理/VPN 拦截国内镜像时的典型底层报错特征（TLS 握手中途 socket 被断、连接重置等）。
// 命中即在失败提示里追加一句中文引导，避免用户对着英文一头雾水。
const PROXY_ERROR_PATTERNS = [
  'socket disconnected',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'econnrefused',
  'tunneling socket',
  'network socket',
  'tls',
  'certificate',
];

function isLikelyProxyError(error?: string): boolean {
  if (!error) return false;
  const e = String(error).toLowerCase();
  return PROXY_ERROR_PATTERNS.some((p) => e.includes(p));
}

const DownModel: FC<IProps> = ({
  modelName,
  callBack,
  downSource,
  children,
  needsCoreML = true,
  globalDownloading = false,
  format = 'ggml',
  getCopyUrl,
}) => {
  const { t } = useTranslation('common');
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [detail, setDetail] = React.useState<DownloadDetail | null>(null);
  const callBackRef = useRef(callBack);
  callBackRef.current = callBack;
  const progressKey = getProgressKey(modelName, format);

  useEffect(() => {
    const handleProgress = (model: string, progressValue: number) => {
      if (model?.toLowerCase() === progressKey?.toLowerCase()) {
        setProgress(progressValue);
      }
    };

    const handleDetail = (model: string, detailData: DownloadDetail) => {
      if (model?.toLowerCase() === progressKey?.toLowerCase()) {
        setDetail(detailData);
      }
    };

    const unsubProgress = window?.ipc?.on('downloadProgress', handleProgress);
    const unsubDetail = window?.ipc?.on('modelDownloadDetail', handleDetail);

    return () => {
      unsubProgress?.();
      unsubDetail?.();
    };
  }, [progressKey]);

  const handleDownModel = useCallback(async () => {
    if (globalDownloading) return;
    try {
      setLoading(true);
      setProgress(0);
      setDetail(null);
      const result =
        format === 'ct2'
          ? await window?.ipc?.invoke('downloadCt2Model', {
              model: modelName,
              source: downSource,
            })
          : await window?.ipc?.invoke('downloadModel', {
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
        toast.error(
          t('downloadFailedToast', { error: result.error }),
          isLikelyProxyError(result.error)
            ? { description: t('downloadProxyHint'), duration: 8000 }
            : undefined,
        );
      }
    } catch (error) {
      console.error('Download model failed:', error);
      setLoading(false);
    }
  }, [modelName, downSource, needsCoreML, globalDownloading, format, t]);

  const handleCancel = useCallback(async () => {
    try {
      await window?.ipc?.invoke('cancelModelDownload');
    } catch (error) {
      console.error('Cancel model download failed:', error);
    }
  }, []);

  const isDisabled = globalDownloading && !loading;

  // 下载源在「点击下载时」才选择：上层通过 DownloadSourceProvider 注入源配置时，
  // 点击下载先弹气泡选源，确认后再真正下载；无配置时（设置页 / 引导页）保持直接下载。
  const sourceConfig = useDownloadSource();
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const triggerDownload = sourceConfig
    ? () => setPickerOpen(true)
    : handleDownModel;

  const child = React.isValidElement<{
    loading?: boolean;
    progress?: number;
    detail?: DownloadDetail | null;
    handleDownModel?: () => void;
    handleCancel?: () => void;
    disabled?: boolean;
  }>(children)
    ? React.cloneElement(children, {
        loading,
        progress,
        detail,
        handleDownModel: triggerDownload,
        handleCancel,
        disabled: isDisabled,
      })
    : children;

  const anchor = <span className="inline-block">{child}</span>;

  if (!sourceConfig) return anchor;

  return (
    <DownloadSourcePopover
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      config={sourceConfig}
      onConfirm={handleDownModel}
      getCopyUrl={getCopyUrl}
    >
      {anchor}
    </DownloadSourcePopover>
  );
};

export default DownModel;
