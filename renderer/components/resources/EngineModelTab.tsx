import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Badge } from '@/components/ui/badge';
import { TooltipProvider } from '@/components/ui/tooltip';
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
import { Download, ArrowUpCircle, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import FasterWhisperPanel from '@/components/resources/engines/panels/FasterWhisperPanel';
import FunasrPanel from '@/components/resources/engines/panels/FunasrPanel';
import QwenPanel from '@/components/resources/engines/panels/QwenPanel';
import LocalCliPanel from '@/components/resources/engines/panels/LocalCliPanel';
import BuiltinPanel from '@/components/resources/engines/panels/BuiltinPanel';
import EngineIcon from '@/components/resources/engines/EngineIcon';
import ModelLibrarySection from '@/components/resources/ModelLibrarySection';
import {
  readPersistedDownloadSource,
  persistDownloadSource,
} from '@/components/settings/gpu/gpuDownloadUtils';
import type { DownloadSource } from '../../../types/addon';
import type {
  EngineStatus,
  PyEngineDownloadProgress,
  PyEngineUpdateInfo,
  TranscriptionEngine,
} from '../../../types/engine';
import { ISystemInfo } from '../../../types/types';

const PY_ENGINE_SIZE = '170MB';

type EngineStatuses = Partial<Record<TranscriptionEngine, EngineStatus>>;
type StatusTone = 'ready' | 'pending' | 'downloading' | 'error';

const ENGINES: TranscriptionEngine[] = [
  'builtin',
  'fasterWhisper',
  'funasr',
  'qwen',
  'localCli',
];

function isQueueBusy(status: string | undefined): boolean {
  return status === 'running' || status === 'paused' || status === 'cancelling';
}

function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        tone === 'ready' && 'bg-success',
        tone === 'error' && 'bg-destructive',
        tone === 'downloading' && 'bg-primary animate-pulse',
        tone === 'pending' && 'bg-muted-foreground/40',
      )}
    />
  );
}

/**
 * 统一「引擎与模型」主从双栏视图：左栏引擎列表（状态点，无启用开关），
 * 右栏 = 选中引擎的运行时管理（内联各引擎面板，无弹窗）+ 该引擎模型清单。
 * 选中态为本地 state，不写全局；不提供"设为当前/启用"。
 */
const EngineModelTab: React.FC = () => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [selectedEngine, setSelectedEngine] =
    useState<TranscriptionEngine>('builtin');

  // 引擎运行时状态
  const [engineStatuses, setEngineStatuses] = useState<EngineStatuses>({});
  const [device, setDevice] = useState<'auto' | 'cpu' | 'cuda'>('auto');
  const [computeType, setComputeType] = useState('auto');
  const [whisperCommand, setWhisperCommand] = useState('');
  const [localCliEnabled, setLocalCliEnabled] = useState(false);
  const [platform, setPlatform] = useState('');
  const [downloadProgress, setDownloadProgress] =
    useState<PyEngineDownloadProgress | null>(null);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const taskBusyRef = useRef(false);
  const [updateInfo, setUpdateInfo] = useState<PyEngineUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [funasrPkgInstalled, setFunasrPkgInstalled] = useState(false);
  const [funasrModelsReady, setFunasrModelsReady] = useState(false);
  const [qwenPkgInstalled, setQwenPkgInstalled] = useState(false);
  const [qwenModelsReady, setQwenModelsReady] = useState(false);
  const [binarySource, setBinarySource] = useState<DownloadSource>(() =>
    typeof window === 'undefined' ? 'github' : readPersistedDownloadSource(),
  );

  // 模型清单数据（供右栏 ModelLibrarySection 与左栏 builtin 就绪点）
  const [systemInfo, setSystemInfo] = useState<ISystemInfo>({
    modelsInstalled: [],
    downloadingModels: [],
    modelsPath: '',
  });
  const [systemInfoLoaded, setSystemInfoLoaded] = useState(false);
  const [globalDownloading, setGlobalDownloading] = useState(false);

  const updateSystemInfo = useCallback(async () => {
    try {
      const res = await window?.ipc?.invoke('getSystemInfo', null);
      if (res) setSystemInfo(res);
    } catch (error) {
      console.error('Failed to load system info:', error);
    } finally {
      setSystemInfoLoaded(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [statuses, settings, progress, taskStatus, env] = await Promise.all(
        [
          window?.ipc?.invoke('get-engine-status'),
          window?.ipc?.invoke('getSettings'),
          window?.ipc?.invoke('get-py-engine-download-progress'),
          window?.ipc?.invoke('getTaskStatus'),
          window?.ipc?.invoke('get-gpu-environment'),
        ],
      );
      if (statuses) setEngineStatuses(statuses);
      if (settings) {
        setDevice(settings.fasterWhisperDevice || 'auto');
        setComputeType(settings.fasterWhisperComputeType || 'auto');
        setWhisperCommand(settings.whisperCommand || '');
        setLocalCliEnabled(!!settings.useLocalWhisper);
      }
      if (progress) setDownloadProgress(progress);
      if (env?.platform) setPlatform(env.platform);
      const busy = isQueueBusy(taskStatus);
      setTaskBusy(busy);
      taskBusyRef.current = busy;

      const fr = await window?.ipc?.invoke('getFunasrModelStatus');
      if (fr?.success) {
        setFunasrPkgInstalled(!!fr.engineInstalled);
        setFunasrModelsReady(!!fr.ready);
      }

      const qr = await window?.ipc?.invoke('getQwenModelStatus');
      if (qr?.success) {
        setQwenPkgInstalled(!!qr.engineInstalled);
        setQwenModelsReady(!!qr.ready);
      }
    } catch (error) {
      console.error('Failed to refresh engine status:', error);
    }
  }, []);

  useEffect(() => {
    refresh();
    updateSystemInfo();

    const unsubProgress = window?.ipc?.on(
      'py-engine-download-progress',
      (_progress: PyEngineDownloadProgress) => {
        // 仅反映 faster-whisper 引擎包进度；funasr 运行库进度由 FunasrPanel 自行处理。
        if (_progress.engineId && _progress.engineId !== 'faster-whisper') {
          return;
        }
        setDownloadProgress(_progress);
        if (_progress.status === 'completed') {
          // 下载完成后引擎仍需冷启动校验，期间保持「检测中」，挡住重复点击。
          setVerifying(true);
          setUpdateInfo(null);
          (async () => {
            try {
              await window?.ipc?.invoke('python-engine:ping', {
                engineId: 'faster-whisper',
              });
            } catch {
              // 校验失败交给 refresh() 反映真实状态（broken → 显示修复入口）
            } finally {
              await refresh();
              setVerifying(false);
            }
          })();
        } else if (_progress.status === 'error') {
          if (_progress.error === 'protocol_unsupported') {
            toast.error(t('engines.fasterWhisper.protocolUnsupported'));
          }
          refresh();
        }
      },
    );
    const unsubTask = window?.ipc?.on('taskStatusChange', (status: string) => {
      const busy = isQueueBusy(status);
      setTaskBusy(busy);
      taskBusyRef.current = busy;
    });
    const unsubUpdate = window?.ipc?.on(
      'py-engine-update-available',
      (info: PyEngineUpdateInfo & { engineId?: string }) => {
        if (info.engineId && info.engineId !== 'faster-whisper') return;
        setUpdateInfo(info);
      },
    );
    const unsubDownload = window?.ipc?.on(
      'downloadProgress',
      (_model: string, progressValue: number) => {
        setGlobalDownloading(progressValue >= 0 && progressValue < 1);
        if (progressValue >= 1) void updateSystemInfo();
      },
    );
    return () => {
      unsubProgress?.();
      unsubTask?.();
      unsubUpdate?.();
      unsubDownload?.();
    };
  }, [refresh, updateSystemInfo, t]);

  // 模型/引擎变更后同时刷新清单与引擎状态，保证左栏就绪点即时更新
  const handleResourcesUpdate = useCallback(() => {
    void updateSystemInfo();
    void refresh();
  }, [updateSystemInfo, refresh]);

  const handleSaveWhisperCommand = async () => {
    try {
      await window?.ipc?.invoke('setSettings', { whisperCommand });
      toast.success(t('engines.localCli.commandSaved'));
      void refresh();
    } catch {
      toast.error(t('engines.localCli.commandSaveFailed'));
    }
  };

  // localCli「启用」沿用 useLocalWhisper：开启后任务页「引擎 ▸ 模型」选择器才会列出本地命令行。
  const handleToggleLocalCli = async (value: boolean) => {
    setLocalCliEnabled(value);
    try {
      await window?.ipc?.invoke('setSettings', { useLocalWhisper: value });
      void refresh();
    } catch {
      setLocalCliEnabled(!value);
    }
  };

  const handleStartDownload = async () => {
    setShowDownloadConfirm(false);
    const result = await window?.ipc?.invoke('start-py-engine-download', {
      source: binarySource,
    });
    if (!result?.success) {
      toast.error(
        result?.error === 'engine_busy'
          ? t('engines.fasterWhisper.engineBusy')
          : result?.error || 'Failed to start download',
      );
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const result = await window?.ipc?.invoke('check-py-engine-update', {
        source: binarySource,
      });
      if (!result?.success) {
        toast.error(t('engines.fasterWhisper.checkFailed'));
        return;
      }
      const info = result.info as PyEngineUpdateInfo;
      setUpdateInfo(info);
      if (!info.protocolSupported) {
        toast.error(t('engines.fasterWhisper.protocolUnsupported'));
      } else if (info.hasUpdate) {
        toast.success(t('engines.fasterWhisper.updateAvailable'));
      } else {
        toast.success(t('engines.fasterWhisper.upToDate'));
      }
    } catch {
      toast.error(t('engines.fasterWhisper.checkFailed'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleUpgrade = async () => {
    setShowUpgradeConfirm(false);
    const result = await window?.ipc?.invoke('start-py-engine-download', {
      source: binarySource,
    });
    if (!result?.success) {
      toast.error(
        result?.error === 'engine_busy'
          ? t('engines.fasterWhisper.engineBusy')
          : result?.error || 'Failed to start upgrade',
      );
    }
  };

  const handleUninstall = async () => {
    setShowUninstallConfirm(false);
    const result = await window?.ipc?.invoke('uninstall-py-engine');
    if (result?.success) {
      setVerifying(false);
      setUpdateInfo(null);
      await refresh();
    } else {
      toast.error(result?.error || 'Failed to uninstall');
    }
  };

  const handleDeviceChange = async (value: string) => {
    const next = value as 'auto' | 'cpu' | 'cuda';
    setDevice(next);
    await window?.ipc?.invoke('set-faster-whisper-settings', { device: next });
  };

  const handleComputeTypeChange = async (value: string) => {
    setComputeType(value);
    await window?.ipc?.invoke('set-faster-whisper-settings', {
      computeType: value,
    });
  };

  const fasterStatus = engineStatuses.fasterWhisper;
  const localCliStatus = engineStatuses.localCli;
  const isDownloading =
    downloadProgress?.status === 'downloading' ||
    downloadProgress?.status === 'extracting' ||
    fasterStatus?.state === 'downloading';
  const fasterInstalled = fasterStatus?.state === 'ready';
  const fasterBroken = fasterStatus?.state === 'error';
  const showVerifying = verifying || downloadProgress?.status === 'verifying';
  const hasUpdate = !!(updateInfo?.hasUpdate && updateInfo.protocolSupported);
  const localCliReady =
    localCliEnabled &&
    (localCliStatus?.state === 'ready' || whisperCommand.trim().length > 0);

  // 安全网：引擎一旦确认 ready/broken，立即清掉「检测中」标志
  useEffect(() => {
    if (verifying && (fasterInstalled || fasterBroken)) setVerifying(false);
  }, [verifying, fasterInstalled, fasterBroken]);

  const deviceOptions =
    platform === 'darwin' ? ['auto', 'cpu'] : ['auto', 'cpu', 'cuda'];

  const readyBadge = (
    <Badge variant="outline" className="border-success/40 text-success">
      {t('engines.statusAvailable')}
    </Badge>
  );

  const renderEngineBadge = (engine: TranscriptionEngine) => {
    if (engine === 'fasterWhisper') {
      if (isDownloading) {
        return (
          <Badge variant="secondary" className="shrink-0">
            {t('engines.fasterWhisper.downloading')}
          </Badge>
        );
      }
      if (showVerifying) {
        return (
          <Badge variant="secondary" className="shrink-0">
            {t('engines.fasterWhisper.verifying')}
          </Badge>
        );
      }
      if (fasterInstalled) return readyBadge;
      if (fasterBroken) {
        return (
          <Badge variant="destructive" className="shrink-0">
            {t('engines.fasterWhisper.installError')}
          </Badge>
        );
      }
      return (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t('engines.fasterWhisper.notInstalled')}
        </Badge>
      );
    }
    if (engine === 'funasr') {
      if (funasrPkgInstalled && funasrModelsReady) return readyBadge;
      if (funasrPkgInstalled && !funasrModelsReady) {
        return (
          <Badge variant="outline" className="border-primary/40 text-primary">
            {t('engines.funasr.needsModels')}
          </Badge>
        );
      }
      return (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t('engines.funasr.notInstalled')}
        </Badge>
      );
    }
    if (engine === 'qwen') {
      if (qwenPkgInstalled && qwenModelsReady) return readyBadge;
      if (qwenPkgInstalled && !qwenModelsReady) {
        return (
          <Badge variant="outline" className="border-primary/40 text-primary">
            {t('engines.qwen.needsModels')}
          </Badge>
        );
      }
      return (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t('engines.qwen.notInstalled')}
        </Badge>
      );
    }
    if (engine === 'localCli') {
      return localCliReady ? (
        readyBadge
      ) : (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t('engines.localCli.notConfigured')}
        </Badge>
      );
    }
    // builtin：内置运行时无需安装，始终就绪；模型可用性在下方模型清单单独体现。
    return readyBadge;
  };

  const engineTone = (engine: TranscriptionEngine): StatusTone => {
    if (engine === 'fasterWhisper') {
      if (isDownloading || showVerifying) return 'downloading';
      if (fasterInstalled) return 'ready';
      if (fasterBroken) return 'error';
      return 'pending';
    }
    if (engine === 'funasr') {
      return funasrPkgInstalled && funasrModelsReady ? 'ready' : 'pending';
    }
    if (engine === 'qwen') {
      return qwenPkgInstalled && qwenModelsReady ? 'ready' : 'pending';
    }
    if (engine === 'localCli') return localCliReady ? 'ready' : 'pending';
    return 'ready';
  };

  const engineName = (engine: TranscriptionEngine) =>
    t(`engines.${engine}.name`);

  const renderBinarySourceSelector = () => (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('engines.fasterWhisper.downloadSource')}
      </p>
      <div className="flex gap-2">
        {(['github', 'ghproxy', 'gitcode'] as DownloadSource[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setBinarySource(s);
              persistDownloadSource(s);
            }}
            className={`flex-1 px-3 py-2 rounded-md border text-xs transition-all ${
              binarySource === s
                ? 'border-primary bg-primary/5 font-medium'
                : 'border-muted hover:border-primary/50'
            }`}
          >
            {s === 'github'
              ? 'GitHub'
              : s === 'gitcode'
                ? 'GitCode'
                : t('ghProxy')}
          </button>
        ))}
      </div>
    </div>
  );

  const fasterWhisperPanelProps = {
    status: fasterStatus,
    isDownloading,
    downloadProgress,
    showVerifying,
    fasterInstalled,
    fasterBroken,
    hasUpdate,
    checkingUpdate,
    taskBusy,
    device,
    computeType,
    deviceOptions,
    updateInfo,
    onDownload: () => setShowDownloadConfirm(true),
    onRepair: () => setShowDownloadConfirm(true),
    onUninstall: () => setShowUninstallConfirm(true),
    onCheckUpdate: handleCheckUpdate,
    onUpgrade: () => setShowUpgradeConfirm(true),
    onDeviceChange: handleDeviceChange,
    onComputeTypeChange: handleComputeTypeChange,
  };

  const renderRuntimePanel = () => {
    if (selectedEngine === 'fasterWhisper') {
      return <FasterWhisperPanel {...fasterWhisperPanelProps} />;
    }
    if (selectedEngine === 'funasr') {
      return (
        <FunasrPanel
          status={engineStatuses.funasr}
          taskBusy={taskBusy}
          defaultSource={binarySource}
          onRefreshStatuses={refresh}
        />
      );
    }
    if (selectedEngine === 'qwen') {
      return (
        <QwenPanel
          status={engineStatuses.qwen}
          taskBusy={taskBusy}
          defaultSource={binarySource}
          onRefreshStatuses={refresh}
        />
      );
    }
    if (selectedEngine === 'localCli') {
      return (
        <LocalCliPanel
          whisperCommand={whisperCommand}
          onCommandChange={setWhisperCommand}
          onSave={handleSaveWhisperCommand}
          enabled={localCliEnabled}
          onToggleEnabled={handleToggleLocalCli}
        />
      );
    }
    return <BuiltinPanel />;
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-4 pb-4 md:flex-row">
        {/* 左栏：引擎列表（状态点，无启用开关） */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-52 md:flex-col md:overflow-visible md:border-r md:pr-2">
          {ENGINES.map((id) => {
            const active = selectedEngine === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSelectedEngine(id)}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  'shrink-0 md:w-full',
                  active
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-foreground hover:bg-muted/60',
                )}
              >
                <EngineIcon engine={id} className="h-4 w-4 shrink-0" />
                <span className="truncate">{engineName(id)}</span>
                <span className="ml-auto">
                  <StatusDot tone={engineTone(id)} />
                </span>
              </button>
            );
          })}
        </nav>

        {/* 右栏：选中引擎运行时 + 模型清单 */}
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">
              {engineName(selectedEngine)}
            </h2>
            {renderEngineBadge(selectedEngine)}
          </div>

          {renderRuntimePanel()}

          <div className="border-t pt-4">
            <ModelLibrarySection
              engine={selectedEngine}
              systemInfo={systemInfo}
              systemInfoLoaded={systemInfoLoaded}
              globalDownloading={globalDownloading}
              onUpdate={handleResourcesUpdate}
            />
          </div>
        </div>
      </div>

      <AlertDialog
        open={showDownloadConfirm}
        onOpenChange={setShowDownloadConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('engines.fasterWhisper.download', { size: PY_ENGINE_SIZE })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.fasterWhisper.downloadConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {renderBinarySourceSelector()}
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5"
              onClick={handleStartDownload}
            >
              <Download className="h-4 w-4" />
              {t('engines.fasterWhisper.download', { size: PY_ENGINE_SIZE })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showUpgradeConfirm}
        onOpenChange={setShowUpgradeConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('engines.fasterWhisper.upgrade')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.fasterWhisper.upgradeConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {renderBinarySourceSelector()}
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction className="gap-1.5" onClick={handleUpgrade}>
              <ArrowUpCircle className="h-4 w-4" />
              {t('engines.fasterWhisper.upgrade')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showUninstallConfirm}
        onOpenChange={setShowUninstallConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('engines.fasterWhisper.uninstall')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.fasterWhisper.uninstallConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleUninstall}
            >
              <Trash2 className="h-4 w-4" />
              {t('engines.fasterWhisper.uninstall')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
};

export default EngineModelTab;
