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
import { Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import FasterWhisperPanel from '@/components/resources/engines/panels/FasterWhisperPanel';
import SherpaEngineGroupPanel, {
  type SherpaFamilyKey,
} from '@/components/resources/engines/SherpaEngineGroupPanel';
import LocalCliPanel from '@/components/resources/engines/panels/LocalCliPanel';
import BuiltinPanel from '@/components/resources/engines/panels/BuiltinPanel';
import CloudAsrPanel from '@/components/resources/engines/panels/CloudAsrPanel';
import EngineIcon from '@/components/resources/engines/EngineIcon';
import ModelLibrarySection from '@/components/resources/ModelLibrarySection';
import { type DownloadSourceConfig } from '@/components/resources/engines/DownloadSourcePopover';
import { resolveModelDownloadUrl } from 'lib/resolveModelDownloadUrl';
import { useSherpaRuntime } from '@/components/resources/engines/useSherpaRuntime';
import useLocalStorageState from 'hooks/useLocalStorageState';
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
import {
  isAsrProviderConfigured,
  type AsrProvider,
} from '../../../types/asrProvider';
import { ISystemInfo } from '../../../types/types';

type EngineStatuses = Partial<Record<TranscriptionEngine, EngineStatus>>;
type StatusTone = 'ready' | 'pending' | 'downloading' | 'error';

/**
 * 左栏「视图」单位：多数与真实引擎 id 一一对应；'sherpa' 是把同源（共用 sherpa-onnx
 * 运行库）的 FunASR · Qwen · FireRed 合并为一项展示（仅 UI 合并，后端引擎 id 不变）。
 */
type EngineView = TranscriptionEngine | 'sherpa';

/** sherpa 展示组覆盖的真实引擎 id（顺序即组内分区顺序）。 */
const SHERPA_FAMILIES: SherpaFamilyKey[] = ['funasr', 'qwen', 'fireRedAsr'];

const ENGINE_VIEWS: EngineView[] = [
  'builtin',
  'fasterWhisper',
  'sherpa',
  'localCli',
  'cloud',
];

function isQueueBusy(status: string | undefined): boolean {
  return status === 'running' || status === 'paused' || status === 'cancelling';
}

function StatusDot({ tone, label }: { tone: StatusTone; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
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

  // 记住上次选中的视图，避免每次进入页面都跳回 builtin。
  // 用新 key（engineModelSelectedView）：旧 key 可能存了 funasr/qwen/fireRedAsr，
  // 现已并入 'sherpa' 组，换 key 自然回落默认，避免读到失效选项。
  const [selectedView, setSelectedView] = useLocalStorageState<EngineView>(
    'engineModelSelectedView',
    'builtin',
    (v) => (ENGINE_VIEWS as string[]).includes(v as string),
  );

  // FunASR 与 Qwen 共用的 sherpa-onnx 运行库状态（上提到此常驻组件，切换引擎不丢进度）。
  const sherpa = useSherpaRuntime();

  // 引擎运行时状态
  const [engineStatuses, setEngineStatuses] = useState<EngineStatuses>({});
  const [device, setDevice] = useState<'auto' | 'cpu' | 'cuda'>('auto');
  const [computeType, setComputeType] = useState('auto');
  const [whisperCommand, setWhisperCommand] = useState('');
  const [localCliEnabled, setLocalCliEnabled] = useState(false);
  const [platform, setPlatform] = useState('');
  // 运行时变体：cpu=默认包（所有平台），cuda=Full GPU 包（仅 Win/Linux，捆绑 cuBLAS/cuDNN）。
  // 下载前的选择记忆在本地；已安装变体以引擎状态(manifest)为准。
  const [selectedVariant, setSelectedVariant] = useLocalStorageState<
    'cpu' | 'cuda'
  >('fasterWhisperVariant', 'cpu', (v) => v === 'cpu' || v === 'cuda');
  // 是否检测到可用的 NVIDIA(CUDA) 显卡（用于 GPU 选项的「推荐」标记/提示）。
  const [nvidiaSupported, setNvidiaSupported] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<PyEngineDownloadProgress | null>(null);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const taskBusyRef = useRef(false);
  const [updateInfo, setUpdateInfo] = useState<PyEngineUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  // 运行库（sherpa-onnx）随包内置，不再做安装检测；三族状态只看「是否已下载模型」。
  const [funasrModelsReady, setFunasrModelsReady] = useState(false);
  const [qwenModelsReady, setQwenModelsReady] = useState(false);
  const [fireRedModelsReady, setFireRedModelsReady] = useState(false);
  // 云端听写：已配置实例存在即就绪（面板内变更经 onProvidersChange 即时回传）。
  const [asrProviders, setAsrProviders] = useState<AsrProvider[]>([]);
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
    // GPU 环境探测（首次含 nvidia-smi）较慢，独立异步加载、不进首屏 Promise.all，
    // 避免拖慢引擎/模型状态渲染；platform 就绪后再补设（仅用于平台相关展示）。
    void Promise.resolve(window?.ipc?.invoke('get-gpu-environment'))
      .then((env) => {
        if (env?.platform) setPlatform(env.platform);
        setNvidiaSupported(!!env?.nvidia?.gpuSupport?.supported);
      })
      .catch(() => {});
    try {
      const [statuses, settings, progress, taskStatus] = await Promise.all([
        window?.ipc?.invoke('get-engine-status'),
        window?.ipc?.invoke('getSettings'),
        window?.ipc?.invoke('get-py-engine-download-progress'),
        window?.ipc?.invoke('getTaskStatus'),
      ]);
      if (statuses) setEngineStatuses(statuses);
      if (settings) {
        setDevice(settings.fasterWhisperDevice || 'auto');
        setComputeType(settings.fasterWhisperComputeType || 'auto');
        setWhisperCommand(settings.whisperCommand || '');
        setLocalCliEnabled(!!settings.useLocalWhisper);
      }
      if (progress) setDownloadProgress(progress);
      const busy = isQueueBusy(taskStatus);
      setTaskBusy(busy);
      taskBusyRef.current = busy;

      const fr = await window?.ipc?.invoke('getFunasrModelStatus');
      if (fr?.success) {
        setFunasrModelsReady(!!fr.ready);
      }

      const qr = await window?.ipc?.invoke('getQwenModelStatus');
      if (qr?.success) {
        setQwenModelsReady(!!qr.ready);
      }

      const frr = await window?.ipc?.invoke('getFireRedModelStatus');
      if (frr?.success) {
        setFireRedModelsReady(!!frr.ready);
      }

      const asr = await window?.ipc?.invoke('getAsrProviders');
      if (Array.isArray(asr)) setAsrProviders(asr);
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
        // 仅反映 faster-whisper 引擎包进度；sherpa 运行库已内置无下载进度。
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

  // 当前已安装变体（manifest 来源）；未安装/老安装按 cpu 兜底。
  const installedVariantOf = (): 'cpu' | 'cuda' =>
    engineStatuses.fasterWhisper?.variant === 'cuda' ? 'cuda' : 'cpu';
  const isGpuVariantPlatform = () =>
    platform === 'win32' || platform === 'linux';

  /**
   * 统一的运行时下载入口。coupleDevice=true（仅在「选择/切换变体」时）联动计算设备：
   * GPU 包→auto；CPU 包→cpu（CPU 包无 CUDA 运行库，置 cpu 可规避 cublas 加载报错）。
   */
  const startEngineDownload = async (
    variant: 'cpu' | 'cuda',
    coupleDevice = false,
  ) => {
    const result = await window?.ipc?.invoke('start-py-engine-download', {
      source: binarySource,
      variant,
    });
    if (!result?.success) {
      toast.error(
        result?.error === 'engine_busy'
          ? t('engines.fasterWhisper.engineBusy')
          : result?.error || 'Failed to start download',
      );
      return;
    }
    if (coupleDevice) {
      const nextDevice: 'auto' | 'cpu' = variant === 'cuda' ? 'auto' : 'cpu';
      setDevice(nextDevice);
      try {
        await window?.ipc?.invoke('set-faster-whisper-settings', {
          device: nextDevice,
        });
      } catch {
        // 设备偏好写入失败不影响下载本身
      }
    }
  };

  const handleStartDownload = () =>
    startEngineDownload(isGpuVariantPlatform() ? selectedVariant : 'cpu', true);

  // 修复/升级沿用已安装变体；切换变体则显式下载目标变体并联动设备。
  const handleRepair = () => startEngineDownload(installedVariantOf());

  const handleSwitchVariant = (target: 'cpu' | 'cuda') => {
    setSelectedVariant(target);
    return startEngineDownload(target, true);
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const result = await window?.ipc?.invoke('check-py-engine-update', {
        source: binarySource,
        variant: installedVariantOf(),
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

  const handleUpgrade = () => startEngineDownload(installedVariantOf());

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
  const installedVariant: 'cpu' | 'cuda' | undefined = fasterStatus?.variant;
  // GPU 包仅 Win/Linux 提供；其余平台强制 cpu。
  const gpuVariantAvailable = platform === 'win32' || platform === 'linux';
  const effectiveSelectedVariant: 'cpu' | 'cuda' = gpuVariantAvailable
    ? selectedVariant
    : 'cpu';
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

  // 设备选项随已安装变体收敛：CPU 包不暴露 cuda（用不了，避免误选后 cublas 报错）；
  // GPU 包(cuda) 才提供 auto/cpu/cuda；macOS 恒无 cuda。
  const deviceOptions =
    platform === 'darwin'
      ? ['auto', 'cpu']
      : installedVariant === 'cuda'
        ? ['auto', 'cpu', 'cuda']
        : ['auto', 'cpu'];

  // sherpa 展示组三族就绪态（共用内置运行库，差异在模型）；供合并面板、左栏状态点、徽标聚合。
  const sherpaFamilies = SHERPA_FAMILIES.map((engine) => {
    if (engine === 'funasr') {
      return {
        engine,
        modelsReady: funasrModelsReady,
        status: engineStatuses.funasr,
      };
    }
    if (engine === 'qwen') {
      return {
        engine,
        modelsReady: qwenModelsReady,
        status: engineStatuses.qwen,
      };
    }
    return {
      engine,
      modelsReady: fireRedModelsReady,
      status: engineStatuses.fireRedAsr,
    };
  });
  const sherpaAnyReady = sherpaFamilies.some((f) => f.modelsReady);
  const cloudAnyReady = asrProviders.some((p) => isAsrProviderConfigured(p));

  const readyBadge = (
    <Badge variant="outline" className="border-success/40 text-success">
      {t('engines.statusAvailable')}
    </Badge>
  );

  const renderEngineBadge = (view: EngineView) => {
    if (view === 'sherpa') {
      // 组徽标：任一族就绪即视为可用；否则提示去下载模型（运行库已内置，无"未安装"态）。
      return sherpaAnyReady ? (
        readyBadge
      ) : (
        <Badge variant="outline" className="border-primary/40 text-primary">
          {t('engines.sherpa.needsModels')}
        </Badge>
      );
    }
    if (view === 'cloud') {
      // 云引擎无运行时/模型下载：有已配置实例即就绪，否则提示去添加实例。
      return cloudAnyReady ? (
        readyBadge
      ) : (
        <Badge variant="outline" className="border-primary/40 text-primary">
          {t('engines.cloud.needsConfig')}
        </Badge>
      );
    }
    const engine = view;
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
    if (engine === 'localCli') {
      return localCliReady ? (
        readyBadge
      ) : (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t('engines.localCli.notConfigured')}
        </Badge>
      );
    }
    // builtin：内置运行时无需安装；未装任何 ggml 模型时提示去下载模型。
    if ((systemInfo.modelsInstalled?.length ?? 0) > 0) return readyBadge;
    return (
      <Badge variant="outline" className="border-primary/40 text-primary">
        {t('engines.builtin.needsModels')}
      </Badge>
    );
  };

  const engineTone = (view: EngineView): StatusTone => {
    if (view === 'sherpa') return sherpaAnyReady ? 'ready' : 'pending';
    if (view === 'cloud') return cloudAnyReady ? 'ready' : 'pending';
    if (view === 'fasterWhisper') {
      if (isDownloading || showVerifying) return 'downloading';
      if (fasterInstalled) return 'ready';
      if (fasterBroken) return 'error';
      return 'pending';
    }
    if (view === 'localCli') return localCliReady ? 'ready' : 'pending';
    // builtin：内置运行时始终可用，但未装任何模型则无法转写，按待办呈现。
    return (systemInfo.modelsInstalled?.length ?? 0) > 0 ? 'ready' : 'pending';
  };

  const engineName = (view: EngineView) => t(`engines.${view}.name`);

  // 引擎特色标签：sherpa 组展示 FunASR / Qwen3-ASR / FireRedASR 三平台，让用户一眼看出
  // 该引擎同时支持这三个平台；其余引擎展示能力关键词（如 NVIDIA / 高速 / Apple 芯片）。
  const engineTags = (view: EngineView): string[] => {
    const raw = t(`engines.${view}.tags`, { returnObjects: true });
    return Array.isArray(raw) ? (raw as string[]) : [];
  };

  const statusLabel = (tone: StatusTone) => t(`engines.status.${tone}`);

  const handleBinarySourceChange = (s: DownloadSource) => {
    setBinarySource(s);
    persistDownloadSource(s);
  };

  // 引擎二进制下载源（GitHub / 国内加速 / GitCode）：在「点击下载/升级时」于气泡内选择，
  // 与各模型下载源统一为同款气泡交互。
  const binarySourceConfig: DownloadSourceConfig = {
    value: binarySource,
    options: (['github', 'ghproxy', 'gitcode'] as DownloadSource[]).map(
      (s) => ({
        value: s,
        label:
          s === 'github'
            ? 'GitHub'
            : s === 'gitcode'
              ? 'GitCode'
              : t('ghProxy'),
      }),
    ),
    onChange: (s) => handleBinarySourceChange(s as DownloadSource),
    label: t('engines.fasterWhisper.downloadSource'),
    confirmLabel: commonT('startDownload'),
    // 复制链接反映目标变体：已安装时取已装变体（升级气泡），未安装时取当前选择（安装气泡）。
    getCopyUrl: (s) =>
      resolveModelDownloadUrl(
        'pyEngine',
        s,
        undefined,
        fasterInstalled ? installedVariant || 'cpu' : effectiveSelectedVariant,
      ),
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
    binarySourceConfig,
    selectedVariant: effectiveSelectedVariant,
    onSelectedVariantChange: (v: 'cpu' | 'cuda') => setSelectedVariant(v),
    installedVariant,
    gpuVariantAvailable,
    nvidiaSupported,
    onDownload: handleStartDownload,
    onRepair: handleRepair,
    onSwitchVariant: handleSwitchVariant,
    onUninstall: () => setShowUninstallConfirm(true),
    onCheckUpdate: handleCheckUpdate,
    onUpgrade: handleUpgrade,
    onDeviceChange: handleDeviceChange,
    onComputeTypeChange: handleComputeTypeChange,
  };

  const renderRuntimePanel = () => {
    if (selectedView === 'fasterWhisper') {
      return <FasterWhisperPanel {...fasterWhisperPanelProps} />;
    }
    if (selectedView === 'sherpa') {
      return (
        <SherpaEngineGroupPanel
          runtime={sherpa}
          families={sherpaFamilies}
          systemInfo={systemInfo}
          systemInfoLoaded={systemInfoLoaded}
          globalDownloading={globalDownloading}
          onUpdate={handleResourcesUpdate}
        />
      );
    }
    if (selectedView === 'localCli') {
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
    if (selectedView === 'cloud') {
      return <CloudAsrPanel onProvidersChange={setAsrProviders} />;
    }
    return <BuiltinPanel />;
  };

  return (
    <TooltipProvider delayDuration={150}>
      {/* 左栏固定、仅右栏滚动：根容器撑满父高，左 nav 整列常驻，右栏独立纵向滚动。 */}
      <div className="flex h-full min-h-0 flex-col gap-4 md:flex-row">
        {/* 左栏：引擎列表（状态点，无启用开关）——md 下整列固定，不随右栏滚动 */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-56 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:pr-2">
          {ENGINE_VIEWS.map((id) => {
            const active = selectedView === id;
            const tone = engineTone(id);
            const tags = engineTags(id);
            return (
              <button
                key={id}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => setSelectedView(id)}
                className={cn(
                  'flex items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  'shrink-0 md:w-full',
                  active
                    ? 'bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/20'
                    : 'text-foreground hover:bg-muted/60',
                )}
              >
                <EngineIcon engine={id} className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate">{engineName(id)}</span>
                    <span className="ml-auto flex shrink-0">
                      <StatusDot tone={tone} label={statusLabel(tone)} />
                    </span>
                  </span>
                  {tags.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-normal leading-none',
                            active
                              ? 'bg-primary/15 text-primary'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </nav>

        {/* 右栏：选中引擎运行时 + 模型清单（独立纵向滚动） */}
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pb-4 md:pl-1">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">
                {engineName(selectedView)}
              </h2>
              {selectedView === 'sherpa' && (
                <p className="text-xs text-muted-foreground">
                  {t('engines.sherpa.subtitle')}
                </p>
              )}
              {selectedView === 'cloud' && (
                <p className="text-xs text-muted-foreground">
                  {t('engines.cloud.subtitle')}
                </p>
              )}
            </div>
            {renderEngineBadge(selectedView)}
          </div>

          {renderRuntimePanel()}

          {/* sherpa 组的模型清单由组面板内联渲染；cloud 无本地模型清单（模型在实例内配置）。 */}
          {selectedView !== 'sherpa' && selectedView !== 'cloud' && (
            <div className="border-t pt-4">
              <ModelLibrarySection
                engine={selectedView}
                systemInfo={systemInfo}
                systemInfoLoaded={systemInfoLoaded}
                globalDownloading={globalDownloading}
                onUpdate={handleResourcesUpdate}
              />
            </div>
          )}
        </div>
      </div>

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
