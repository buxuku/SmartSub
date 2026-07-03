import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'next-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import FasterWhisperPanel from '@/components/resources/engines/panels/FasterWhisperPanel';
import SherpaEngineGroupPanel, {
  type SherpaFamilyKey,
} from '@/components/resources/engines/SherpaEngineGroupPanel';
import LocalCliPanel from '@/components/resources/engines/panels/LocalCliPanel';
import BuiltinPanel from '@/components/resources/engines/panels/BuiltinPanel';
import CloudProviderPanel from '@/components/resources/engines/panels/CloudProviderPanel';
import EngineIcon from '@/components/resources/engines/EngineIcon';
import AsrProviderIcon from '@/components/resources/engines/AsrProviderIcon';
import ModelLibrarySection from '@/components/resources/ModelLibrarySection';
import { type DownloadSourceConfig } from '@/components/resources/engines/DownloadSourcePopover';
import { resolveModelDownloadUrl } from 'lib/resolveModelDownloadUrl';
import { useSherpaRuntime } from '@/components/resources/engines/useSherpaRuntime';
import useLocalStorageState from 'hooks/useLocalStorageState';
import useAsrProviders from 'hooks/useAsrProviders';
import {
  LOCAL_ENGINE_VIEWS,
  isEngineViewId,
  type EngineView,
  type LocalEngineView,
} from 'lib/engineViews';
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
  ASR_OPENAI_COMPATIBLE,
  buildCloudViews,
  cloudCustomViewId,
  cloudViewTypeId,
  resolveLegacyCloudView,
} from '../../../types/asrProvider';
import { ISystemInfo } from '../../../types/types';

type EngineStatuses = Partial<Record<TranscriptionEngine, EngineStatus>>;
type StatusTone = 'ready' | 'pending' | 'downloading' | 'error';

/** sherpa 展示组覆盖的真实引擎 id（顺序即组内分区顺序）。 */
const SHERPA_FAMILIES: SherpaFamilyKey[] = ['funasr', 'qwen', 'fireRedAsr'];

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
 * 统一「引擎与模型」主从双栏视图：左栏分「本地引擎」「云端听写」两组
 * （本地 = 引擎列表；云 = 每个服务商类型一个平级入口，数据驱动自
 * ASR_PROVIDER_TYPES），右栏 = 选中视图的运行时管理 / 服务商配置面板。
 * 选中态为本地 state，不写全局；不提供"设为当前/启用"。
 */
const EngineModelTab: React.FC = () => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  // 记住上次选中的视图，避免每次进入页面都跳回 builtin。
  // 校验宽进（接受 cloud:* 与历史遗留 'cloud'），实例加载后统一收敛（见下方 effect）。
  const [selectedView, setSelectedView] = useLocalStorageState<EngineView>(
    'engineModelSelectedView',
    'builtin',
    isEngineViewId,
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
  // 云端听写实例的单一事实源：左栏状态点/计数与右栏面板共用（见 useAsrProviders）。
  const asr = useAsrProviders();
  // 「添加自定义」对话框（云组末尾入口）：命名 + 可选 Base URL，新建 OpenAI 兼容实例。
  const [addCustomOpen, setAddCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customApiUrl, setCustomApiUrl] = useState('');
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

  // 左栏「云端听写」组条目清单（品牌单例 + 协议预设槽位 + 自定义实例 + 孤儿兜底）。
  const cloudViews = useMemo(
    () => buildCloudViews(asr.providers),
    [asr.providers],
  );

  /**
   * 视图归一：历史遗留 'cloud'（旧单一云入口）映射到首个已配置条目；
   * cloud:* 命中条目清单则为云视图；其余按本地视图（未知值回落 builtin）。
   */
  const selectedRaw = selectedView as string;
  const activeCloudView = (() => {
    if (selectedRaw === 'cloud') {
      const vid = resolveLegacyCloudView(asr.providers);
      return cloudViews.find((v) => v.viewId === vid) ?? null;
    }
    return cloudViews.find((v) => v.viewId === selectedRaw) ?? null;
  })();
  const effectiveLocalView: LocalEngineView = (
    LOCAL_ENGINE_VIEWS as readonly string[]
  ).includes(selectedRaw)
    ? (selectedRaw as LocalEngineView)
    : 'builtin';

  /**
   * 实例加载后持续收敛选中态：legacy 'cloud' 写回新格式；失效的 cloud:* 视图
   * （自定义条目被删 / 类型下线且无孤儿实例 / 旧格式 id）优先回落同类型首个
   * 条目（如 OpenAI 预设槽位），无同类条目再回落 builtin。
   */
  useEffect(() => {
    if (!asr.loaded) return;
    const raw = selectedView as string;
    if (raw === 'cloud') {
      setSelectedView(resolveLegacyCloudView(asr.providers) as EngineView);
      return;
    }
    const typeId = cloudViewTypeId(raw);
    if (!typeId || cloudViews.some((v) => v.viewId === raw)) return;
    const sameType = cloudViews.find((v) => v.type.id === typeId);
    setSelectedView((sameType?.viewId ?? 'builtin') as EngineView);
  }, [asr.loaded, asr.providers, cloudViews, selectedView, setSelectedView]);

  const readyBadge = (
    <Badge variant="outline" className="border-success/40 text-success">
      {t('engines.statusAvailable')}
    </Badge>
  );

  const renderEngineBadge = (view: LocalEngineView) => {
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

  const engineTone = (view: LocalEngineView): StatusTone => {
    if (view === 'sherpa') return sherpaAnyReady ? 'ready' : 'pending';
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

  const engineName = (view: LocalEngineView) => t(`engines.${view}.name`);

  // 引擎特色标签：sherpa 组展示 FunASR / Qwen3-ASR / FireRedASR 三平台，让用户一眼看出
  // 该引擎同时支持这三个平台；其余引擎展示能力关键词（如 NVIDIA / 高速 / Apple 芯片）。
  const engineTags = (view: LocalEngineView): string[] => {
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

  // 新建自定义 OpenAI 兼容实例并跳转到其条目（名称必填，Base URL 可选）。
  const handleAddCustom = () => {
    const id = asr.addCustomInstance(
      ASR_OPENAI_COMPATIBLE,
      customName,
      customApiUrl,
    );
    setAddCustomOpen(false);
    setCustomName('');
    setCustomApiUrl('');
    if (id) {
      setSelectedView(
        cloudCustomViewId(ASR_OPENAI_COMPATIBLE, id) as EngineView,
      );
    }
  };

  const renderRuntimePanel = () => {
    if (activeCloudView) {
      return (
        <CloudProviderPanel
          view={activeCloudView}
          onUpdateField={asr.updateInstanceField}
          onMaterialize={asr.addInstance}
          onRemove={asr.removeInstance}
        />
      );
    }
    if (effectiveLocalView === 'fasterWhisper') {
      return <FasterWhisperPanel {...fasterWhisperPanelProps} />;
    }
    if (effectiveLocalView === 'sherpa') {
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
    if (effectiveLocalView === 'localCli') {
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
      {/* 左栏固定、仅右栏滚动：根容器撑满父高，左 nav 整列常驻，右栏独立纵向滚动。 */}
      <div className="flex h-full min-h-0 flex-col gap-4 md:flex-row">
        {/* 左栏两组：本地引擎（两行样式 + tags）/ 云端听写（每服务商一个紧凑入口）。
            小屏退化为横向滚动，组标题隐藏、条目顺序不变。 */}
        <nav className="flex shrink-0 gap-2 overflow-x-auto md:w-56 md:flex-col md:gap-3 md:overflow-x-visible md:overflow-y-auto md:border-r md:pr-2">
          <div className="flex shrink-0 gap-1 md:flex-col">
            <div className="hidden px-3 pb-1 text-xs font-medium text-muted-foreground md:block">
              {t('engines.groups.local')}
            </div>
            {LOCAL_ENGINE_VIEWS.map((id) => {
              const active = !activeCloudView && effectiveLocalView === id;
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
          </div>

          <div className="flex shrink-0 gap-1 md:flex-col">
            <div className="hidden px-3 pb-1 text-xs font-medium text-muted-foreground md:block">
              {t('engines.groups.cloud')}
            </div>
            {cloudViews.map((v) => {
              const active = activeCloudView?.viewId === v.viewId;
              const tone: StatusTone = v.configured ? 'ready' : 'pending';
              return (
                <button
                  key={v.viewId}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSelectedView(v.viewId as EngineView)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors',
                    'shrink-0 md:w-full',
                    active
                      ? 'bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/20'
                      : 'text-foreground hover:bg-muted/60',
                  )}
                >
                  <AsrProviderIcon
                    type={{ icon: v.icon, iconImg: v.iconImg }}
                  />
                  <span className="min-w-0 flex-1 truncate" title={v.label}>
                    {v.label}
                  </span>
                  <StatusDot tone={tone} label={statusLabel(tone)} />
                </button>
              );
            })}
            {/* 固定在云组末尾的「添加自定义」：接入任意 OpenAI 兼容端点 */}
            <button
              type="button"
              onClick={() => setAddCustomOpen(true)}
              className={cn(
                'flex items-center gap-2 rounded-lg border border-dashed border-input px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                'shrink-0 md:w-full',
              )}
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
                <Plus className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {t('cloudAsr.addCustom')}
              </span>
            </button>
          </div>
        </nav>

        {/* 右栏：选中引擎运行时 / 云服务商配置 + 模型清单（独立纵向滚动） */}
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pb-4 md:pl-1">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">
                {activeCloudView
                  ? activeCloudView.kind === 'brand'
                    ? activeCloudView.type.name
                    : activeCloudView.label
                  : engineName(effectiveLocalView)}
              </h2>
              {/* 预设槽位/自定义条目以类型全名作副标题（标明协议归属） */}
              {activeCloudView &&
                (activeCloudView.kind === 'preset' ||
                  activeCloudView.kind === 'custom') && (
                  <p className="text-xs text-muted-foreground">
                    {activeCloudView.type.name}
                  </p>
                )}
              {!activeCloudView && effectiveLocalView === 'sherpa' && (
                <p className="text-xs text-muted-foreground">
                  {t('engines.sherpa.subtitle')}
                </p>
              )}
            </div>
            {activeCloudView ? (
              activeCloudView.configured ? (
                readyBadge
              ) : (
                <Badge
                  variant="outline"
                  className="border-primary/40 text-primary"
                >
                  {t('engines.cloud.notConfigured')}
                </Badge>
              )
            ) : (
              renderEngineBadge(effectiveLocalView)
            )}
          </div>

          {renderRuntimePanel()}

          {/* sherpa 组的模型清单由组面板内联渲染；云服务商无本地模型清单（模型在面板内配置）。 */}
          {!activeCloudView && effectiveLocalView !== 'sherpa' && (
            <div className="border-t pt-4">
              <ModelLibrarySection
                engine={effectiveLocalView}
                systemInfo={systemInfo}
                systemInfoLoaded={systemInfoLoaded}
                globalDownloading={globalDownloading}
                onUpdate={handleResourcesUpdate}
              />
            </div>
          )}
        </div>
      </div>

      {/* 添加自定义 OpenAI 兼容实例 */}
      <Dialog open={addCustomOpen} onOpenChange={setAddCustomOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('cloudAsr.addCustom')}</DialogTitle>
            <DialogDescription>{t('cloudAsr.addCustomDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label htmlFor="asr-custom-name" className="text-sm font-medium">
                {t('cloudAsr.instanceName')}
                <span className="text-destructive"> *</span>
              </label>
              <Input
                id="asr-custom-name"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customName.trim()) handleAddCustom();
                }}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="asr-custom-url" className="text-sm font-medium">
                {t('cloudAsr.baseUrlOptional')}
              </label>
              <Input
                id="asr-custom-url"
                value={customApiUrl}
                onChange={(e) => setCustomApiUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setAddCustomOpen(false);
                setCustomName('');
                setCustomApiUrl('');
              }}
            >
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </Button>
            <Button
              className="gap-1.5"
              disabled={!customName.trim()}
              onClick={handleAddCustom}
            >
              <Plus className="h-4 w-4" />
              {t('cloudAsr.addCustom')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
