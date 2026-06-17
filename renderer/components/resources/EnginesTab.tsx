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
import {
  Box,
  X,
  Zap,
  Terminal,
  Cpu,
  Download,
  ArrowUpCircle,
  Languages,
  Layers,
} from 'lucide-react';
import { toast } from 'sonner';
import SectionHeader from '@/components/SectionHeader';
import EngineWorkbenchCard from '@/components/resources/engines/EngineWorkbenchCard';
import EngineManageDrawer from '@/components/resources/engines/EngineManageDrawer';
import FasterWhisperPanel from '@/components/resources/engines/panels/FasterWhisperPanel';
import FunasrPanel from '@/components/resources/engines/panels/FunasrPanel';
import LocalCliPanel from '@/components/resources/engines/panels/LocalCliPanel';
import BuiltinPanel from '@/components/resources/engines/panels/BuiltinPanel';
import BaseRuntimePanel from '@/components/resources/engines/panels/BaseRuntimePanel';
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

const PY_ENGINE_SIZE = '170MB';
const FUNASR_ENGINE_SIZE = '20MB';

type EngineStatuses = Partial<Record<TranscriptionEngine, EngineStatus>>;
type ManageTarget = TranscriptionEngine | 'base';

function isQueueBusy(status: string | undefined): boolean {
  return status === 'running' || status === 'paused' || status === 'cancelling';
}

interface EnginesTabProps {
  onNavigateTab?: (tab: string) => void;
}

const EnginesTab: React.FC<EnginesTabProps> = ({ onNavigateTab }) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [currentEngine, setCurrentEngine] =
    useState<TranscriptionEngine>('builtin');
  const [engineStatuses, setEngineStatuses] = useState<EngineStatuses>({});
  const [device, setDevice] = useState<'auto' | 'cpu' | 'cuda'>('auto');
  const [computeType, setComputeType] = useState('auto');
  const [whisperCommand, setWhisperCommand] = useState('');
  const [platform, setPlatform] = useState('');
  const [downloadProgress, setDownloadProgress] =
    useState<PyEngineDownloadProgress | null>(null);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  // 「下载并启用」意图：在各下载入口显式置位，区分安装(true)与升级/修复(false)。
  const pendingActivateRef = useRef(false);
  // 任务忙碌的最新值：下载进度监听器闭包里的 taskBusy 是旧值，改读这个 ref。
  const taskBusyRef = useRef(false);
  const [updateInfo, setUpdateInfo] = useState<PyEngineUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [manageTarget, setManageTarget] = useState<ManageTarget | null>(null);
  // funasr 卡片仅需轻量状态（包是否安装/模型是否就绪）驱动徽章与「设为当前」可用性，
  // 其余包生命周期逻辑在自包含的 FunasrPanel 内。
  const [funasrPkgInstalled, setFunasrPkgInstalled] = useState(false);
  const [funasrModelsReady, setFunasrModelsReady] = useState(false);

  const [binarySource, setBinarySource] = useState<DownloadSource>(() =>
    typeof window === 'undefined' ? 'github' : readPersistedDownloadSource(),
  );

  const refresh = useCallback(async () => {
    try {
      const [engine, statuses, settings, progress, taskStatus, env] =
        await Promise.all([
          window?.ipc?.invoke('get-transcription-engine'),
          window?.ipc?.invoke('get-engine-status'),
          window?.ipc?.invoke('getSettings'),
          window?.ipc?.invoke('get-py-engine-download-progress'),
          window?.ipc?.invoke('getTaskStatus'),
          window?.ipc?.invoke('get-gpu-environment'),
        ]);

      if (engine) setCurrentEngine(engine);
      if (statuses) setEngineStatuses(statuses);
      if (settings) {
        setDevice(settings.fasterWhisperDevice || 'auto');
        setComputeType(settings.fasterWhisperComputeType || 'auto');
        setWhisperCommand(settings.whisperCommand || '');
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
    } catch (error) {
      console.error('Failed to refresh engine status:', error);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsubProgress = window?.ipc?.on(
      'py-engine-download-progress',
      (_progress: PyEngineDownloadProgress) => {
        // 此监听只反映 faster-whisper 引擎包进度；funasr 由下方独立监听 + FunasrPanel 处理。
        if (_progress.engineId && _progress.engineId !== 'faster-whisper') {
          return;
        }
        setDownloadProgress(_progress);
        if (_progress.status === 'completed') {
          // 下载完成后引擎还需冷启动校验（PyInstaller 首帧加载），期间保持「检测中」，
          // 避免用户以为卡住没反应、且能挡住下载/修复按钮被重复点击。
          setVerifying(true);
          // 升级/安装成功，清除"有更新"标记
          setUpdateInfo(null);
          (async () => {
            let pingOk = false;
            try {
              const r = await window?.ipc?.invoke('python-engine:ping', {
                engineId: 'faster-whisper',
              });
              pingOk = !!r?.success;
            } catch {
              // 校验失败：忽略错误，交给 refresh() 反映真实状态（broken → 显示修复入口）
            } finally {
              await refresh();
              setVerifying(false);
            }
            // 下载并启用：仅首次安装意图(pendingActivate) + 检测通过(pingOk) 时生效。
            // 任务运行中不切换，仅提示；否则自动设为当前引擎（含 sidecar 预热）。
            if (pendingActivateRef.current && pingOk) {
              if (taskBusyRef.current) {
                toast(t('engines.fasterWhisper.downloadedBusyHint'));
              } else {
                const res = await window?.ipc?.invoke(
                  'set-transcription-engine',
                  'fasterWhisper',
                );
                if (res?.success) {
                  setCurrentEngine('fasterWhisper');
                  window.dispatchEvent(
                    new CustomEvent('transcription-engine-changed'),
                  );
                }
              }
            }
            pendingActivateRef.current = false;
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
    return () => {
      unsubProgress?.();
      unsubTask?.();
      unsubUpdate?.();
    };
  }, [refresh, t]);

  const handleSelectEngine = async (engine: TranscriptionEngine) => {
    if (engine === currentEngine) return;
    if (taskBusy) {
      toast.error(t('engines.switchBlocked'));
      return;
    }

    const result = await window?.ipc?.invoke(
      'set-transcription-engine',
      engine,
    );
    if (result?.success) {
      setCurrentEngine(engine);
      // 通知全局头部引擎指示器即时刷新（set-transcription-engine 不广播）
      window.dispatchEvent(new CustomEvent('transcription-engine-changed'));
      return;
    }

    if (result?.error === 'engine_not_installed') {
      // 用户本就在点「设为当前」→ 下载完成后应自动启用
      pendingActivateRef.current = true;
      setShowDownloadConfirm(true);
      return;
    }

    toast.error(result?.error || 'Failed to switch engine');
  };

  const handleSaveWhisperCommand = async () => {
    try {
      await window?.ipc?.invoke('setSettings', { whisperCommand });
      toast.success(t('engines.localCli.commandSaved'));
    } catch {
      toast.error(t('engines.localCli.commandSaveFailed'));
    }
  };

  const handleStartDownload = async () => {
    setShowDownloadConfirm(false);
    const source = binarySource;
    const result = await window?.ipc?.invoke('start-py-engine-download', {
      source,
    });
    if (!result?.success) {
      if (result?.error === 'engine_busy') {
        toast.error(t('engines.fasterWhisper.engineBusy'));
      } else {
        toast.error(result?.error || 'Failed to start download');
      }
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const source = binarySource;
      const result = await window?.ipc?.invoke('check-py-engine-update', {
        source,
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
    // 升级不切换当前引擎；显式清除可能残留的安装意图（如先开了安装确认又取消）
    pendingActivateRef.current = false;
    setShowUpgradeConfirm(false);
    const source = binarySource;
    const result = await window?.ipc?.invoke('start-py-engine-download', {
      source,
    });
    if (!result?.success) {
      if (result?.error === 'engine_busy') {
        toast.error(t('engines.fasterWhisper.engineBusy'));
      } else {
        toast.error(result?.error || 'Failed to start upgrade');
      }
    }
  };

  const handleUninstall = async () => {
    const result = await window?.ipc?.invoke('uninstall-py-engine');
    if (result?.success) {
      setVerifying(false);
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
  // 「检测中」覆盖两段：下载后的安装校验阶段（downloader 的 'verifying' 状态）
  // 与 completed 后的 ping 冷启动（verifying 标志）。
  const showVerifying = verifying || downloadProgress?.status === 'verifying';
  const hasUpdate = !!(updateInfo?.hasUpdate && updateInfo.protocolSupported);
  const localCliReady =
    localCliStatus?.state === 'ready' || whisperCommand.trim().length > 0;

  // 安全网：引擎一旦确认 ready/broken，立即清掉「检测中」标志，
  // 避免 ping 异常/超时让标志卡住（即便 finally 未及时清理）。
  useEffect(() => {
    if (verifying && (fasterInstalled || fasterBroken)) setVerifying(false);
  }, [verifying, fasterInstalled, fasterBroken]);

  // CTranslate2(faster-whisper) 在 macOS 上不支持 CUDA/Metal，仅 CPU；其它平台保留 cuda
  const deviceOptions =
    platform === 'darwin' ? ['auto', 'cpu'] : ['auto', 'cpu', 'cuda'];

  const readyBadge = (
    <Badge variant="outline" className="border-success/40 text-success">
      {t('engines.statusAvailable')}
    </Badge>
  );

  // 头部徽章只表达「就绪/安装」状态；「使用中」由卡片高亮 + 底部徽章表达，避免重复。
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
    if (engine === 'localCli') {
      return localCliReady ? (
        readyBadge
      ) : (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t('engines.localCli.notConfigured')}
        </Badge>
      );
    }
    return readyBadge;
  };

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

  const drawerTitle = (target: ManageTarget | null): string => {
    if (target === 'base') return t('engines.base.name');
    if (target === 'fasterWhisper') return t('engines.fasterWhisper.name');
    if (target === 'funasr') return t('engines.funasr.name');
    if (target === 'localCli') return t('engines.localCli.name');
    if (target === 'builtin') return t('engines.builtin.name');
    return '';
  };

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
    onDownload: () => {
      pendingActivateRef.current = true;
      setShowDownloadConfirm(true);
    },
    onRepair: () => {
      pendingActivateRef.current = false;
      setShowDownloadConfirm(true);
    },
    onUninstall: handleUninstall,
    onCheckUpdate: handleCheckUpdate,
    onUpgrade: () => setShowUpgradeConfirm(true),
    onDeviceChange: handleDeviceChange,
    onComputeTypeChange: handleComputeTypeChange,
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-4 pb-4">
        <SectionHeader
          icon={Cpu}
          title={t('engines.title')}
          description={t('engines.description')}
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <EngineWorkbenchCard
            isActive={currentEngine === 'builtin'}
            icon={Box}
            name={t('engines.builtin.name')}
            recommended
            recommendedLabel={t('engines.tags.recommended')}
            chips={[
              t('engines.tags.macRecommended'),
              t('engines.tags.noDownload'),
              t('engines.tags.gpu'),
            ]}
            desc={t('engines.builtin.desc')}
            scenario={t('engines.builtin.scenario')}
            badge={renderEngineBadge('builtin')}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive
            setActiveDisabled={taskBusy}
            onSetActive={() => handleSelectEngine('builtin')}
            onManage={() => setManageTarget('builtin')}
          />
          <EngineWorkbenchCard
            isActive={currentEngine === 'fasterWhisper'}
            icon={Zap}
            name={t('engines.fasterWhisper.name')}
            chips={[
              t('engines.tags.faster'),
              t('engines.tags.accurateTimestamps'),
              ...(fasterInstalled
                ? []
                : [t('engines.tags.needsDownload', { size: PY_ENGINE_SIZE })]),
            ]}
            desc={t('engines.fasterWhisper.desc')}
            scenario={t('engines.fasterWhisper.scenario')}
            badge={renderEngineBadge('fasterWhisper')}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive
            setActiveDisabled={taskBusy}
            onSetActive={() => handleSelectEngine('fasterWhisper')}
            onManage={() => setManageTarget('fasterWhisper')}
          />
          <EngineWorkbenchCard
            isActive={currentEngine === 'funasr'}
            icon={Languages}
            name={t('engines.funasr.name')}
            recommended
            recommendedLabel={t('engines.tags.chineseRecommended')}
            chips={[
              t('engines.tags.multilang'),
              t('engines.tags.cpuFriendly'),
              ...(funasrPkgInstalled
                ? []
                : [
                    t('engines.tags.needsDownload', {
                      size: FUNASR_ENGINE_SIZE,
                    }),
                  ]),
            ]}
            desc={t('engines.funasr.desc')}
            scenario={t('engines.funasr.scenario')}
            badge={renderEngineBadge('funasr')}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive={funasrPkgInstalled}
            setActiveDisabled={taskBusy}
            onSetActive={() => handleSelectEngine('funasr')}
            onManage={() => setManageTarget('funasr')}
          />
          <EngineWorkbenchCard
            isActive={currentEngine === 'localCli'}
            icon={Terminal}
            name={t('engines.localCli.name')}
            chips={[t('engines.tags.advanced'), t('engines.tags.byoModel')]}
            desc={t('engines.localCli.desc')}
            scenario={t('engines.localCli.scenario')}
            badge={renderEngineBadge('localCli')}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive
            setActiveDisabled={taskBusy}
            onSetActive={() => handleSelectEngine('localCli')}
            onManage={() => setManageTarget('localCli')}
          />
          {/* 基座运行时卡片：复用工作台卡片，不提供「设为当前」，状态在管理抽屉内展示 */}
          <EngineWorkbenchCard
            isActive={false}
            icon={Layers}
            name={t('engines.base.name')}
            chips={[]}
            desc={t('engines.base.desc')}
            badge={<span />}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive={false}
            onSetActive={() => {}}
            onManage={() => setManageTarget('base')}
          />
        </div>

        <EngineManageDrawer
          target={manageTarget}
          onOpenChange={(open) => !open && setManageTarget(null)}
          title={drawerTitle(manageTarget)}
        >
          {manageTarget === 'fasterWhisper' && (
            <FasterWhisperPanel {...fasterWhisperPanelProps} />
          )}
          {manageTarget === 'funasr' && (
            <FunasrPanel
              status={engineStatuses.funasr}
              taskBusy={taskBusy}
              defaultSource={binarySource}
              onRefreshStatuses={refresh}
              onGoModels={() => onNavigateTab?.('models')}
            />
          )}
          {manageTarget === 'localCli' && (
            <LocalCliPanel
              whisperCommand={whisperCommand}
              onCommandChange={setWhisperCommand}
              onSave={handleSaveWhisperCommand}
            />
          )}
          {manageTarget === 'builtin' && (
            <BuiltinPanel onGoModels={() => onNavigateTab?.('models')} />
          )}
          {manageTarget === 'base' && (
            <BaseRuntimePanel
              taskBusy={taskBusy}
              defaultSource={binarySource}
            />
          )}
        </EngineManageDrawer>

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
      </div>
    </TooltipProvider>
  );
};

export default EnginesTab;
