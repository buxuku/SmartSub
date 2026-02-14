import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Zap,
  Download,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Cpu,
  Check,
  ZapOff,
  CloudDownload,
  FolderOpen,
  FileCode,
  ExternalLink,
  Info,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  CudaEnvironment,
  DownloadProgress,
  CudaVersion,
  DownloadSource,
  AddonUpdateInfo,
} from '../../../types/addon';

interface InstalledAddonInfo {
  version: CudaVersion;
  info: {
    installedAt: string;
    remoteVersion: string;
    hasDlls: boolean;
    size: number;
  };
}

const AVAILABLE_VERSIONS: CudaVersion[] = [
  '11.8.0',
  '12.2.0',
  '12.4.0',
  '13.0.2',
];

const GpuAccelerationCard: React.FC = () => {
  const { t } = useTranslation('settings');

  // 状态
  const [cudaEnv, setCudaEnv] = useState<CudaEnvironment | null>(null);
  const [installedAddons, setInstalledAddons] = useState<InstalledAddonInfo[]>(
    [],
  );
  const [selectedVersion, setSelectedVersion] = useState<CudaVersion | null>(
    null,
  );
  const [useCuda, setUseCuda] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null);
  const [downloadSource, setDownloadSource] =
    useState<DownloadSource>('github');
  const [isLoading, setIsLoading] = useState(true);
  const [updates, setUpdates] = useState<AddonUpdateInfo[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [downloadingVersion, setDownloadingVersion] =
    useState<CudaVersion | null>(null);
  const [customAddonPath, setCustomAddonPath] = useState<string | null>(null);
  const lastToastStatus = useRef<string | null>(null);
  const downloadingVersionRef = useRef<CudaVersion | null>(null);

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  // 格式化时间
  const formatEta = (seconds: number): string => {
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    if (seconds < 3600)
      return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  // 加载数据
  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);

      // 获取 CUDA 环境信息
      const env = await window?.ipc?.invoke('get-cuda-environment');
      setCudaEnv(env);

      // 获取已安装的加速包
      const addons = await window?.ipc?.invoke('get-installed-addons');
      setInstalledAddons(addons || []);

      // 获取当前选中的版本
      const selected = await window?.ipc?.invoke('get-selected-addon-version');
      setSelectedVersion(selected);

      // 获取自定义 addon 路径
      const customPath = await window?.ipc?.invoke('get-custom-addon-path');
      setCustomAddonPath(customPath);

      // 获取设置
      const settings = await window?.ipc?.invoke('getSettings');
      setUseCuda(settings?.useCuda || false);
    } catch (error) {
      console.error('Failed to load GPU acceleration data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 单独监听下载进度
  useEffect(() => {
    const handleProgress = async (progress: DownloadProgress) => {
      // 更新进度状态
      setDownloadProgress(progress);

      if (progress.status === 'completed') {
        // 下载完成：显示提示
        if (lastToastStatus.current !== 'completed') {
          toast.success(t('gpuAcceleration.downloadComplete'));
          toast.info(t('gpuAcceleration.restartRequired'));
          lastToastStatus.current = 'completed';
        }

        // 获取当前下载的版本
        const completedVersion = downloadingVersionRef.current;

        // 延迟清除进度条，让用户看到 100%
        setTimeout(async () => {
          setDownloadProgress(null);
          setDownloadingVersion(null);
          downloadingVersionRef.current = null;

          // 刷新数据
          await loadData();

          // 自动启用 CUDA 并选中刚下载的版本
          if (completedVersion) {
            try {
              // 显式通过 IPC 持久化选中版本，避免依赖后端异步回调的竞态问题
              await window?.ipc?.invoke(
                'select-addon-version',
                completedVersion,
              );
              await window?.ipc?.invoke('setSettings', { useCuda: true });
              setUseCuda(true);
              setSelectedVersion(completedVersion);
              notifyGpuSettingsChanged();
            } catch (error) {
              console.error('Failed to enable CUDA after download:', error);
            }
          }
        }, 1000);
      } else if (progress.status === 'error') {
        // 下载失败
        if (lastToastStatus.current !== 'error') {
          toast.error(progress.error || t('gpuAcceleration.downloadFailed'));
          lastToastStatus.current = 'error';
        }
        setDownloadingVersion(null);
        downloadingVersionRef.current = null;
      } else if (progress.status === 'downloading') {
        // 开始下载时重置 toast 状态
        lastToastStatus.current = null;
      }
    };

    const cleanup = window?.ipc?.on('addon-download-progress', handleProgress);

    return () => {
      if (cleanup) {
        cleanup();
      }
    };
  }, [loadData, t]);

  // 通知 Layout 组件 GPU 设置已变更
  const notifyGpuSettingsChanged = () => {
    window.dispatchEvent(new Event('gpu-settings-changed'));
  };

  // 选择禁用 CUDA（选中"不启用"卡片）
  const handleDisableCuda = async () => {
    try {
      await window?.ipc?.invoke('setSettings', { useCuda: false });
      await window?.ipc?.invoke('select-addon-version', null);
      // 同时清除自定义路径
      if (customAddonPath) {
        await window?.ipc?.invoke('set-custom-addon-path', null);
        setCustomAddonPath(null);
      }
      setUseCuda(false);
      setSelectedVersion(null);
      notifyGpuSettingsChanged();
      toast.info(t('gpuAcceleration.cudaDisabled'));
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  // 选择版本（同时启用 CUDA，并清除自定义路径）
  const handleVersionSelect = async (version: CudaVersion) => {
    try {
      // 同时设置选中版本和启用 CUDA
      await window?.ipc?.invoke('select-addon-version', version);
      await window?.ipc?.invoke('setSettings', { useCuda: true });
      setSelectedVersion(version);
      setCustomAddonPath(null); // 互斥：选择版本时清除自定义路径
      setUseCuda(true);
      notifyGpuSettingsChanged();
      toast.success(t('gpuAcceleration.versionSelected'));
      toast.info(t('gpuAcceleration.restartRequired'));
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  // 开始下载
  const handleDownload = async (version: CudaVersion) => {
    if (!version) return;

    const downloadType = cudaEnv?.recommendation.needsDlls
      ? 'tar.gz'
      : 'node.gz';
    setDownloadingVersion(version);
    downloadingVersionRef.current = version;

    try {
      await window?.ipc?.invoke('start-addon-download', {
        source: downloadSource,
        cudaVersion: version,
        type: downloadType,
      });
      toast.info(t('gpuAcceleration.downloadStarted'));
    } catch (error) {
      toast.error(t('gpuAcceleration.downloadFailed'));
      setDownloadingVersion(null);
      downloadingVersionRef.current = null;
    }
  };

  // 取消下载
  const handleCancelDownload = async () => {
    try {
      await window?.ipc?.invoke('cancel-addon-download');
      setDownloadProgress(null);
      setDownloadingVersion(null);
      downloadingVersionRef.current = null;
      toast.info(t('gpuAcceleration.downloadCancelled'));
    } catch (error) {
      console.error('Failed to cancel download:', error);
    }
  };

  // 删除加速包
  const handleRemoveAddon = async (version: CudaVersion) => {
    try {
      await window?.ipc?.invoke('remove-addon', version);
      toast.success(t('gpuAcceleration.addonRemoved'));
      loadData();
    } catch (error) {
      toast.error(t('gpuAcceleration.removeFailed'));
    }
  };

  // 检查更新
  const handleCheckUpdates = async () => {
    setCheckingUpdates(true);
    try {
      const updateInfo = await window?.ipc?.invoke('check-addon-updates');
      setUpdates(updateInfo || []);
      const hasUpdates = updateInfo?.some((u: AddonUpdateInfo) => u.hasUpdate);
      if (hasUpdates) {
        toast.info(t('gpuAcceleration.updatesAvailable'));
      } else {
        toast.success(t('gpuAcceleration.noUpdates'));
      }
    } catch (error) {
      toast.error(t('gpuAcceleration.checkUpdatesFailed'));
    } finally {
      setCheckingUpdates(false);
    }
  };

  // 选择自定义 addon.node 文件
  const handleSelectCustomAddon = async () => {
    try {
      const result = await window?.ipc?.invoke('select-addon-file');
      if (result?.canceled || !result?.filePath) return;

      const setResult = await window?.ipc?.invoke(
        'set-custom-addon-path',
        result.filePath,
      );
      if (setResult?.success) {
        setCustomAddonPath(result.filePath);
        setSelectedVersion(null);
        // 同时启用 CUDA
        await window?.ipc?.invoke('setSettings', { useCuda: true });
        setUseCuda(true);
        notifyGpuSettingsChanged();
        toast.success(t('gpuAcceleration.customAddonSet'));
        toast.info(t('gpuAcceleration.restartRequired'));
      } else {
        toast.error(
          setResult?.error || t('gpuAcceleration.customAddonSetFailed'),
        );
      }
    } catch (error) {
      toast.error(t('gpuAcceleration.customAddonSetFailed'));
    }
  };

  // 清除自定义 addon.node 路径
  const handleClearCustomAddon = async () => {
    try {
      await window?.ipc?.invoke('set-custom-addon-path', null);
      setCustomAddonPath(null);
      notifyGpuSettingsChanged();
      toast.info(t('gpuAcceleration.customAddonCleared'));
      loadData();
    } catch (error) {
      console.error('Failed to clear custom addon path:', error);
    }
  };

  // 检查某版本是否已安装
  const isVersionInstalled = (version: CudaVersion): boolean => {
    return installedAddons.some((a) => a.version === version);
  };

  // 获取某版本的安装信息
  const getVersionInfo = (
    version: CudaVersion,
  ): InstalledAddonInfo | undefined => {
    return installedAddons.find((a) => a.version === version);
  };

  // 检查某版本是否正在下载
  const isVersionDownloading = (version: CudaVersion): boolean => {
    return downloadingVersion === version;
  };

  // 渲染环境检测结果
  const renderEnvironmentInfo = () => {
    if (!cudaEnv) return null;

    const { gpuSupport, cudaToolkit, recommendation } = cudaEnv;

    return (
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            {t('gpuAcceleration.gpu')}:
          </span>
          <span className="font-medium">
            {gpuSupport.gpuName ||
              (gpuSupport.supported
                ? 'NVIDIA GPU'
                : t('gpuAcceleration.notDetected'))}
          </span>
        </div>
        {gpuSupport.driverVersion && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t('gpuAcceleration.driver')}:
            </span>
            <span>{gpuSupport.driverVersion}</span>
          </div>
        )}
        {gpuSupport.maxCudaVersion && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t('gpuAcceleration.maxCuda')}:
            </span>
            <span>{gpuSupport.maxCudaVersion}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            {t('gpuAcceleration.cudaToolkit')}:
          </span>
          <span>
            {cudaToolkit.installed
              ? cudaToolkit.version || t('gpuAcceleration.installed')
              : t('gpuAcceleration.notInstalled')}
          </span>
        </div>
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-muted-foreground">
            {t('gpuAcceleration.status')}:
          </span>
          <div className="flex items-center gap-1">
            {recommendation.canUseCuda ? (
              <>
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span className="text-green-600">
                  {t('gpuAcceleration.supported')}
                </span>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4 text-red-500" />
                <span className="text-red-600">
                  {t('gpuAcceleration.notSupported')}
                </span>
              </>
            )}
          </div>
        </div>
        {recommendation.reason && (
          <p className="text-xs text-muted-foreground pt-1">
            {recommendation.reason}
          </p>
        )}
      </div>
    );
  };

  // 渲染下载进度
  const renderDownloadProgress = () => {
    if (!downloadProgress || downloadProgress.status === 'idle') return null;

    const isDownloading = downloadProgress.status === 'downloading';
    const isExtracting = downloadProgress.status === 'extracting';
    const isVerifying = downloadProgress.status === 'verifying';
    const isError = downloadProgress.status === 'error';
    const isPaused = downloadProgress.status === 'paused';

    return (
      <div className="space-y-2 p-3 bg-muted rounded-lg mt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {downloadingVersion && `CUDA ${downloadingVersion}: `}
            {isDownloading && t('gpuAcceleration.downloading')}
            {isExtracting && t('gpuAcceleration.extracting')}
            {isVerifying && t('gpuAcceleration.verifying')}
            {isError && t('gpuAcceleration.downloadFailed')}
            {isPaused && t('gpuAcceleration.downloadPaused')}
          </span>
          <div className="flex items-center gap-2">
            {(isError || isPaused) && downloadingVersion && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDownload(downloadingVersion)}
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                {t('gpuAcceleration.retry')}
              </Button>
            )}
            {(isDownloading || isPaused) && (
              <Button variant="ghost" size="sm" onClick={handleCancelDownload}>
                {t('cancel')}
              </Button>
            )}
            {isError && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDownloadProgress(null);
                  setDownloadingVersion(null);
                }}
              >
                {t('gpuAcceleration.dismiss')}
              </Button>
            )}
          </div>
        </div>
        <Progress value={downloadProgress.progress} />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {formatSize(downloadProgress.downloaded)} /{' '}
            {formatSize(downloadProgress.total)}
          </span>
          {isDownloading && downloadProgress.speed > 0 && (
            <span>
              {formatSize(downloadProgress.speed)}/s ·{' '}
              {formatEta(downloadProgress.eta)}
            </span>
          )}
          {isError && downloadProgress.error && (
            <span className="text-destructive">{downloadProgress.error}</span>
          )}
        </div>
      </div>
    );
  };

  // 渲染"不启用"卡片
  const renderDisabledCard = () => {
    const isSelected = !useCuda || (!selectedVersion && !customAddonPath);

    return (
      <div
        onClick={handleDisableCuda}
        className={`
          group relative p-3 rounded-lg border-2 transition-all flex-1 min-w-0 cursor-pointer
          ${
            isSelected
              ? 'border-primary bg-primary/5'
              : 'border-muted hover:border-primary/50'
          }
        `}
      >
        {/* 选中指示器 */}
        {isSelected && (
          <div className="absolute top-1.5 right-1.5">
            <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center">
              <Check className="w-2.5 h-2.5 text-primary-foreground" />
            </div>
          </div>
        )}

        {/* 图标 */}
        <div className="flex justify-center mb-2 mt-1">
          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <ZapOff className="w-4 h-4 text-muted-foreground" />
          </div>
        </div>

        {/* 标题 */}
        <div className="text-center mb-1">
          <span className="font-semibold text-sm">
            {t('gpuAcceleration.cpuOnly')}
          </span>
        </div>

        {/* 描述 */}
        <div className="text-center">
          <span className="text-[10px] text-muted-foreground">
            {t('gpuAcceleration.cpuOnlyDesc')}
          </span>
        </div>
      </div>
    );
  };

  // 更新加速包
  const handleUpdateAddon = async (version: CudaVersion) => {
    // 更新操作就是重新下载，会自动覆盖旧文件
    await handleDownload(version);
  };

  // 渲染版本卡片
  const renderVersionCard = (version: CudaVersion) => {
    const installed = isVersionInstalled(version);
    const versionInfo = getVersionInfo(version);
    const isSelected =
      useCuda && version === selectedVersion && !customAddonPath;
    const isRecommended =
      version === cudaEnv?.recommendation.recommendedVersion;
    const hasUpdate = updates.find(
      (u) => u.cudaVersion === version && u.hasUpdate,
    );
    const isDownloading = isVersionDownloading(version);
    const canSelect = installed && !isDownloading;

    return (
      <div
        key={version}
        onClick={() => canSelect && handleVersionSelect(version)}
        className={`
          group relative p-3 rounded-lg border-2 transition-all flex-1 min-w-0
          ${
            installed
              ? isSelected
                ? 'border-primary bg-primary/5 cursor-pointer'
                : 'border-muted hover:border-primary/50 cursor-pointer'
              : 'border-dashed border-muted bg-muted/30 hover:border-muted-foreground/50'
          }
          ${isDownloading ? 'opacity-70' : ''}
        `}
      >
        {/* 选中指示器 */}
        {isSelected && (
          <div className="absolute top-1.5 right-1.5">
            <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center">
              <Check className="w-2.5 h-2.5 text-primary-foreground" />
            </div>
          </div>
        )}

        {/* 有更新角标 */}
        {hasUpdate && !isDownloading && (
          <div className="absolute -top-2 -right-2">
            <Badge
              variant="destructive"
              className="text-[10px] px-1.5 py-0 shadow-sm"
            >
              {t('gpuAcceleration.updateAvailable')}
            </Badge>
          </div>
        )}

        {/* 推荐标识 - 更醒目 */}
        {isRecommended && (
          <div className="absolute -top-2 left-1/2 -translate-x-1/2">
            <Badge className="bg-amber-500 hover:bg-amber-500 text-white text-[10px] px-1.5 py-0 flex items-center gap-0.5">
              <Zap className="w-2.5 h-2.5" />
              {t('gpuAcceleration.recommended')}
            </Badge>
          </div>
        )}

        {/* 版本图标和标题 */}
        <div className="flex justify-center mb-2 mt-1">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center ${installed ? 'bg-green-100 dark:bg-green-900/30' : 'bg-muted'}`}
          >
            {installed ? (
              <Zap className="w-4 h-4 text-green-600 dark:text-green-400" />
            ) : (
              <CloudDownload className="w-4 h-4 text-muted-foreground" />
            )}
          </div>
        </div>

        {/* 版本标题 */}
        <div className="text-center mb-1">
          <span className="font-semibold text-sm">CUDA {version}</span>
        </div>

        {/* 状态和信息 */}
        {installed ? (
          <div className="space-y-1">
            {/* 状态标签 */}
            <div className="flex justify-center gap-1">
              <Badge variant="default" className="text-[10px] px-1.5 py-0">
                <CheckCircle className="w-2.5 h-2.5 mr-0.5" />
                {t('gpuAcceleration.installed')}
              </Badge>
            </div>
            {/* 版本号和大小信息 */}
            <div className="text-[10px] text-muted-foreground text-center">
              {versionInfo?.info.remoteVersion && (
                <span>v{versionInfo.info.remoteVersion}</span>
              )}
              {versionInfo?.info.remoteVersion &&
                versionInfo?.info.size > 0 && <span> · </span>}
              {versionInfo &&
                versionInfo.info.size > 0 &&
                formatSize(versionInfo.info.size)}
            </div>
            {/* 操作按钮 */}
            <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {hasUpdate && !isDownloading && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] text-amber-600 hover:text-amber-700"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUpdateAddon(version);
                  }}
                  disabled={!!downloadingVersion}
                >
                  <RefreshCw className="w-3 h-3 mr-1" />
                  {t('gpuAcceleration.update')}
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] text-destructive hover:text-destructive"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Trash2 className="w-3 h-3 mr-1" />
                    {t('delete')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('gpuAcceleration.confirmDelete')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('gpuAcceleration.confirmDeleteDesc', { version })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => handleRemoveAddon(version)}
                    >
                      {t('delete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {/* 下载中状态 */}
            {isDownloading && (
              <div className="flex items-center justify-center text-[10px] text-muted-foreground">
                <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                {t('gpuAcceleration.updating')}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {/* 未安装提示 */}
            <div className="text-center">
              <span className="text-[10px] text-muted-foreground">
                {t('gpuAcceleration.notDownloaded')}
              </span>
            </div>
            {/* 下载按钮或下载状态 */}
            <div className="h-6 flex items-center justify-center">
              {isDownloading ? (
                <div className="flex items-center text-[10px] text-muted-foreground">
                  <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                  {t('gpuAcceleration.downloading')}
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-6 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDownload(version);
                  }}
                  disabled={!!downloadingVersion}
                >
                  <Download className="w-3 h-3 mr-1" />
                  {t('gpuAcceleration.download')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Zap className="mr-2" />
            {t('gpuAcceleration.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="gpu-acceleration">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center">
            <Zap className="mr-2" />
            {t('gpuAcceleration.title')}
          </div>
          <Button variant="ghost" size="sm" onClick={loadData}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 环境检测 */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Cpu className="w-4 h-4" />
            {t('gpuAcceleration.environmentDetection')}
          </h4>
          {renderEnvironmentInfo()}
        </div>

        {/* 加速包版本卡片 */}
        {cudaEnv?.recommendation.canUseCuda && (
          <div className="pt-4 border-t">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-medium">
                {t('gpuAcceleration.selectAcceleration')}
              </h4>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {t('gpuAcceleration.downloadSource')}
                </span>
                <Select
                  value={downloadSource}
                  onValueChange={(v) => setDownloadSource(v as DownloadSource)}
                >
                  <SelectTrigger className="w-[140px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="ghproxy">
                      {t('gpuAcceleration.ghProxy')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {installedAddons.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={handleCheckUpdates}
                    disabled={checkingUpdates}
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 mr-1 ${checkingUpdates ? 'animate-spin' : ''}`}
                    />
                    {t('gpuAcceleration.checkNewVersion')}
                  </Button>
                )}
              </div>
            </div>

            {/* 5 卡片单行布局：不启用 + 4个CUDA版本 */}
            <div className="flex gap-2">
              {renderDisabledCard()}
              {AVAILABLE_VERSIONS.map((version) => renderVersionCard(version))}
            </div>

            {/* 下载进度 */}
            {renderDownloadProgress()}

            {/* 闪退提示 */}
            <div className="flex items-start gap-2 p-2.5 bg-amber-50 dark:bg-amber-950/30 rounded-md mt-4 border border-amber-200 dark:border-amber-800">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
              <span className="text-[11px] text-amber-700 dark:text-amber-400">
                {t('gpuAcceleration.crashTip')}
              </span>
            </div>

            {/* 自定义加速包 */}
            <div className="mt-4 pt-4 border-t border-dashed">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <FileCode className="w-4 h-4 text-muted-foreground" />
                  <h4 className="text-sm font-medium">
                    {t('gpuAcceleration.customAddonPath')}
                  </h4>
                </div>
                <a
                  href="https://github.com/buxuku/whisper.cpp/releases/tag/latest"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('gpuAcceleration.downloadPackageUrl')}
                </a>
              </div>

              {/* 提示信息 */}
              <div className="flex items-start gap-2 p-2.5 bg-muted/50 rounded-md mb-3">
                <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="text-[11px] text-muted-foreground space-y-1">
                  <p>{t('gpuAcceleration.customAddonTip')}</p>
                  <p>{t('gpuAcceleration.customAddonDllTip')}</p>
                </div>
              </div>

              {customAddonPath ? (
                <div
                  className={`flex items-center gap-2 p-2.5 rounded-lg border-2 ${
                    useCuda ? 'border-primary bg-primary/5' : 'border-muted'
                  }`}
                >
                  <div className="w-7 h-7 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
                    <CheckCircle className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">
                      {t('gpuAcceleration.customAddonActive')}
                    </div>
                    <div
                      className="text-[11px] text-muted-foreground truncate"
                      title={customAddonPath}
                    >
                      {customAddonPath}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleSelectCustomAddon}
                    >
                      <FolderOpen className="w-3.5 h-3.5 mr-1" />
                      {t('gpuAcceleration.selectAddonFile')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={handleClearCustomAddon}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-9 text-xs"
                  onClick={handleSelectCustomAddon}
                >
                  <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
                  {t('gpuAcceleration.selectAddonFile')}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* 不支持 CUDA 的提示 */}
        {!cudaEnv?.recommendation.canUseCuda && (
          <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
            <AlertTriangle className="w-5 h-5 text-yellow-500" />
            <p className="text-sm text-muted-foreground">
              {t('gpuAcceleration.cudaNotAvailable')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default GpuAccelerationCard;
