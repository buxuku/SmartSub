import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertCircle,
  CheckCircle2,
  Compass,
  Cpu,
  Edit3,
  Film,
  Github,
  HelpCircle,
  Keyboard,
  Languages,
  Loader2,
  MessageCircleQuestion,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScrollText,
  Settings,
  X,
  Zap,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from './ThemeToggle';
import { cn, openUrl } from 'lib/utils';
import { hasAnyModelAnyEngine } from 'lib/engineModels';
import { useRouter } from 'next/router';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useTranslation } from 'next-i18next';
import { UpdateDialog } from './UpdateDialog';
import { LogDialog } from './LogDialog';
import OnboardingDialog from './onboarding/OnboardingDialog';
import ShortcutsHelpDialog from './ShortcutsHelpDialog';
import FaqDialog from './FaqDialog';
import useLocalStorageState from 'hooks/useLocalStorageState';
import { useHotkeys } from 'hooks/useHotkeys';
import { useRadixPointerEventsGuard } from 'hooks/useRadixPointerEventsGuard';
import packageInfo from '../../package.json';
import { deriveGpuDisplayState } from '@/components/settings/gpu/gpuDisplayState';
import { backendDisplay } from '@/components/settings/gpu/gpuUtils';
import type { GpuMode } from '../../types/addon';

// 添加更新状态的类型定义
interface UpdateStatus {
  status: string;
  version?: string;
  progress?: number;
  error?: string;
  releaseNotes?: string;
}

interface NavItemDef {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (asPath: string) => boolean;
}

const NAV_ITEMS: NavItemDef[] = [
  {
    href: 'home',
    labelKey: 'tasks',
    icon: MonitorPlay,
    isActive: (p) => p.includes('home') || p.includes('/tasks/'),
  },
  {
    href: 'proofread',
    labelKey: 'subtitleProofread',
    icon: Edit3,
    isActive: (p) => p.includes('proofread'),
  },
  {
    href: 'subtitleMerge',
    labelKey: 'subtitleMerge',
    icon: Film,
    isActive: (p) => p.includes('subtitleMerge'),
  },
  {
    href: 'engines',
    labelKey: 'enginesAndModels',
    icon: Cpu,
    // 资源中心已拆分：/engines 与旧 /resources、/modelsControl 重定向均落于此。
    isActive: (p) =>
      p.includes('/engines') ||
      p.includes('/resources') ||
      p.includes('/modelsControl'),
  },
  {
    href: 'translation',
    labelKey: 'translationServices',
    icon: Languages,
    isActive: (p) =>
      p.includes('/translation') || p.includes('/translateControl'),
  },
  {
    href: 'settings',
    labelKey: 'settings',
    icon: Settings,
    isActive: (p) => p.includes('settings'),
  },
];

function NavItem({
  item,
  locale,
  asPath,
  expanded,
  label,
}: {
  item: NavItemDef;
  locale: string;
  asPath: string;
  expanded: boolean;
  label: string;
}) {
  const Icon = item.icon;
  const active = item.isActive(asPath);
  const link = (
    <Link
      href={`/${locale}/${item.href}`}
      aria-label={label}
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-lg text-sm font-medium transition-colors',
        expanded ? 'px-2.5' : 'w-9 justify-center mx-auto',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Icon className="h-5 w-5 flex-shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
    </Link>
  );

  if (expanded) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={5}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// Radix: 在 DropdownMenuItem 中同步打开 Dialog 会与菜单关闭争用 body 的
// pointer-events，延迟到当前事件循环末尾（菜单已开始关闭）再打开，规避残留导致整页失效
const openAfterMenuClose = (open: () => void) => setTimeout(open, 0);

const Layout = ({ children }) => {
  const {
    t,
    i18n: { language: locale },
  } = useTranslation('common');
  const router = useRouter();
  // 兜底清理 Radix 残留的 body pointer-events 锁（从帮助菜单打开弹窗关闭后整页失效）
  useRadixPointerEventsGuard();
  const gpuModeLabel = (mode: GpuMode) =>
    t(
      mode === 'auto'
        ? 'gpuModeAuto'
        : mode === 'gpu-only'
          ? 'gpuModeGpuOnly'
          : 'gpuModeCpuOnly',
    );
  const { asPath } = router;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [newVersion, setNewVersion] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [accelBadge, setAccelBadge] = useState<{
    mode: 'accel' | 'cpu' | 'pending' | 'warning';
    label: string;
    gpuMode: GpuMode;
  } | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showFaq, setShowFaq] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingResumeStep, setOnboardingResumeStep] = useState<
    number | null
  >(null);
  const onboardingPausedRef = useRef(false);
  const [sidebarExpanded, setSidebarExpanded] = useLocalStorageState<boolean>(
    'sidebarExpanded',
    true,
    (val) => typeof val === 'boolean',
  );
  const [downloadPill, setDownloadPill] = useState<{
    model: string;
    progress: number;
    status: string;
  } | null>(null);
  const [taskRunning, setTaskRunning] = useState(false);
  // 手动检查更新会话：等待 update-status 终态时为 true，持有 loading toast id
  const manualCheckRef = useRef<{ toastId: string | number } | null>(null);

  const checkUpdatesManually = useCallback(() => {
    if (manualCheckRef.current) return;
    manualCheckRef.current = {
      toastId: toast.loading(t('checkingForUpdates')),
    };
    window?.ipc?.invoke('check-for-updates').catch(() => {
      // 失败终态由 update-status error 事件统一收尾
    });
  }, [t]);

  useEffect(() => {
    // 首次启动（无已装模型且无完成标记）自动打开新手引导
    (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (settings?.onboardingCompleted || settings?.useLocalWhisper) return;
        const info = await window?.ipc?.invoke('getSystemInfo', null);
        // 跨引擎就绪判断：任一引擎装有任一模型即视为已就绪，避免已装其它引擎模型仍被重复唤起引导
        if (!hasAnyModelAnyEngine(info)) {
          setShowOnboarding(true);
        }
      } catch (error) {
        console.error('Failed to check onboarding state:', error);
      }
    })();
  }, []);

  useEffect(() => {
    // 监听消息通知
    const cleanupMessage = window?.ipc?.on('message', (res: string) => {
      toast(t('notification'), {
        description: t(res),
      });
      console.log(res);
    });

    // 监听更新状态
    const cleanupUpdateStatus = window?.ipc?.on(
      'update-status',
      (status: UpdateStatus) => {
        if (status.status === 'available') {
          setUpdateAvailable(true);
          setNewVersion(status.version || '');
          setReleaseNotes(status.releaseNotes || '');
        }
        // 手动检查会话收尾：available 开弹窗、not-available 提示已最新、error 静默（全局错误 toast 已有）
        if (
          manualCheckRef.current &&
          ['available', 'not-available', 'error'].includes(status.status)
        ) {
          toast.dismiss(manualCheckRef.current.toastId);
          manualCheckRef.current = null;
          if (status.status === 'available') {
            setShowUpdateDialog(true);
          } else if (status.status === 'not-available') {
            toast.success(t('alreadyLatestVersion'));
          }
        }
      },
    );

    // 应用菜单/设置页触发的手动检查更新
    const cleanupMenuCheck = window?.ipc?.on('menu-check-updates', () => {
      checkUpdatesManually();
    });
    const handleAppCheckUpdates = () => checkUpdatesManually();
    window.addEventListener('app-check-updates', handleAppCheckUpdates);
    // 设置页「关于」卡触发的查看日志
    const handleAppOpenLogs = () => setShowLogs(true);
    window.addEventListener('app-open-logs', handleAppOpenLogs);

    const backendLabels: Record<string, string> = {
      cuda: 'CUDA',
      vulkan: 'Vulkan',
      cpu: 'CPU',
      metal: 'Metal',
      coreml: 'CoreML',
      custom: 'Custom',
    };

    // 检查加速状态（全平台：mac 显示正向 Metal/CoreML 徽章，CPU 态用中性文案）
    const checkGpuStatus = async () => {
      try {
        const env = await window?.ipc?.invoke('get-gpu-environment');
        if (!env) {
          setAccelBadge(null);
          return;
        }

        const settings = await window?.ipc?.invoke('getSettings');
        const active = await window?.ipc?.invoke('get-active-backend');
        const selected = await window?.ipc?.invoke(
          'get-selected-addon-version',
        );
        const customPath = await window?.ipc?.invoke('get-custom-addon-path');
        const gpuMode: GpuMode = settings?.gpuMode || 'auto';
        const state = deriveGpuDisplayState(
          env,
          gpuMode,
          active,
          selected,
          customPath,
        );

        if (state.isDarwin) {
          if (!active) {
            setAccelBadge(null);
          } else if (active.backend === 'cpu') {
            setAccelBadge({ mode: 'cpu', label: '', gpuMode });
          } else {
            setAccelBadge({
              mode: 'accel',
              label: backendDisplay(active),
              gpuMode,
            });
          }
          return;
        }

        switch (state.overviewKind) {
          case 'running':
            setAccelBadge({
              mode: 'accel',
              label: state.accelerationLabel,
              gpuMode,
            });
            break;
          case 'gpuOnlyOnCpu':
            setAccelBadge({ mode: 'warning', label: '', gpuMode });
            break;
          case 'gpuOnlyPending':
          case 'autoPending':
            setAccelBadge({ mode: 'pending', label: '', gpuMode });
            break;
          case 'cpuManual':
          case 'cpuFallback':
            setAccelBadge({ mode: 'cpu', label: '', gpuMode });
            break;
          default:
            setAccelBadge(null);
        }
      } catch (error) {
        console.error('Failed to check GPU status:', error);
      }
    };

    checkGpuStatus();

    // 一次性迁移通知（gpuMode 自动启用告知）
    const checkMigrationNotice = async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (settings?.gpuMigrationNotified === false) {
          toast.info(t('gpuMigrationNotice'), { duration: 10000 });
          await window?.ipc?.invoke('setSettings', {
            gpuMigrationNotified: true,
          });
        }
      } catch (error) {
        console.error('Failed to check migration notice:', error);
      }
    };
    checkMigrationNotice();

    // 降级事件 toast（主进程已做会话内同原因去重）
    const cleanupFallback = window?.ipc?.on(
      'addon-fallback',
      (event: { expected: string; actual: string; reason: string }) => {
        toast.warning(
          t('gpuFallbackToast', {
            backend: backendLabels[event.actual] || event.actual,
          }),
          { duration: 8000 },
        );
        checkGpuStatus();
      },
    );

    // 后端变更推送（转写实际加载后刷新头部徽章）
    const cleanupBackendChanged = window?.ipc?.on(
      'active-backend-changed',
      () => {
        checkGpuStatus();
      },
    );

    // 监听 GPU 设置变更事件（由设置页面触发）
    const handleGpuSettingsChanged = () => {
      checkGpuStatus();
    };
    window.addEventListener('gpu-settings-changed', handleGpuSettingsChanged);

    // 应用菜单「查看日志」
    const cleanupMenuLogs = window?.ipc?.on('menu-open-logs', () => {
      setShowLogs(true);
    });

    // 清理函数
    return () => {
      cleanupMessage?.();
      cleanupUpdateStatus?.();
      cleanupFallback?.();
      cleanupBackendChanged?.();
      cleanupMenuLogs?.();
      cleanupMenuCheck?.();
      window.removeEventListener(
        'gpu-settings-changed',
        handleGpuSettingsChanged,
      );
      window.removeEventListener('app-check-updates', handleAppCheckUpdates);
      window.removeEventListener('app-open-logs', handleAppOpenLogs);
    };
  }, [t, checkUpdatesManually]);

  // 全局任务运行指示：轮询 + taskComplete 即时刷新
  useEffect(() => {
    let disposed = false;
    const refreshTaskRunning = async () => {
      try {
        const status = await window?.ipc?.invoke('getTaskStatus');
        if (!disposed) setTaskRunning(status === 'running');
      } catch {
        if (!disposed) setTaskRunning(false);
      }
    };
    refreshTaskRunning();
    const interval = setInterval(refreshTaskRunning, 4000);
    const cleanupComplete = window?.ipc?.on('taskComplete', () => {
      refreshTaskRunning();
    });
    return () => {
      disposed = true;
      clearInterval(interval);
      cleanupComplete?.();
    };
  }, []);

  // 模型下载全局可见：主进程 modelDownloadDetail 是全局广播，任何页面都能收到
  useEffect(() => {
    let hideTimer: NodeJS.Timeout | null = null;
    const unsub = window?.ipc?.on(
      'modelDownloadDetail',
      (model: string, detail: { status: string; progress: number }) => {
        if (!detail) return;
        if (detail.status === 'downloading' || detail.status === 'extracting') {
          if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
          }
          setDownloadPill({
            model,
            progress: detail.progress ?? 0,
            status: detail.status,
          });
        } else if (detail.status === 'completed' || detail.status === 'error') {
          setDownloadPill({ model, progress: 100, status: detail.status });
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = setTimeout(() => setDownloadPill(null), 5000);
        } else {
          setDownloadPill(null); // idle = 取消，立即隐藏
        }
      },
    );
    return () => {
      unsub?.();
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  const handleUpdateClick = () => {
    setShowUpdateDialog(true);
  };

  // 全局快捷键：Cmd/Ctrl+, 打开设置；? 打开快捷键速查（非输入态）
  useHotkeys([
    {
      combo: 'mod+,',
      allowInInput: true,
      handler: () => router.push(`/${locale}/settings`),
    },
    {
      combo: '?',
      handler: () => setShowShortcuts(true),
    },
  ]);

  /** 引导跳去配置页：记录暂停步骤，展示「继续引导」入口 */
  const handleOnboardingPause = (step: number) => {
    onboardingPausedRef.current = true;
    setOnboardingResumeStep(step);
  };

  const handleOnboardingOpenChange = (open: boolean) => {
    setShowOnboarding(open);
    if (open) return;
    if (!onboardingPausedRef.current) {
      // 正常关闭（完成/跳过/X）：清除暂停状态
      setOnboardingResumeStep(null);
    }
    onboardingPausedRef.current = false;
  };

  const dismissOnboardingResume = async () => {
    setOnboardingResumeStep(null);
    try {
      await window?.ipc?.invoke('setSettings', { onboardingCompleted: true });
    } catch (error) {
      console.error('Failed to mark onboarding completed:', error);
    }
  };

  // 中文标签较短（176px 足够），英文标签如「Translation Services / Proofread Subtitles」
  // 更宽，176px 会被右边框裁断；按 UI 语言放宽展开宽度，保证标签完整可见。
  const isZhLocale = (locale || '').toLowerCase().startsWith('zh');
  const expandedSidebarWidth = isZhLocale ? 'w-[176px]' : 'w-[216px]';
  const expandedContentPad = isZhLocale ? 'pl-[176px]' : 'pl-[216px]';
  const sidebarWidth = sidebarExpanded ? expandedSidebarWidth : 'w-[56px]';

  return (
    <div
      className={cn(
        'grid h-screen w-full transition-[padding-left] duration-200',
        sidebarExpanded ? expandedContentPad : 'pl-[56px]',
      )}
    >
      <aside
        className={cn(
          'inset-y fixed left-0 z-20 flex h-full flex-col border-r transition-[width] duration-200',
          sidebarWidth,
        )}
      >
        <div className="border-b p-2">
          <Link
            href={`/${locale}/home`}
            aria-label="Home"
            className={cn(
              'flex h-10 items-center gap-2 rounded-lg',
              sidebarExpanded ? 'px-2' : 'justify-center',
            )}
          >
            <Image
              src="/images/brand/logo-mark.png"
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 flex-shrink-0 rounded-lg object-contain"
              priority
            />
            {sidebarExpanded && (
              <span className="truncate text-sm font-semibold">
                {t('brandName')}
              </span>
            )}
          </Link>
        </div>
        <nav className="grid gap-1 p-2">
          <TooltipProvider>
            {NAV_ITEMS.map((item) => (
              <NavItem
                key={item.href}
                item={item}
                locale={locale}
                asPath={asPath}
                expanded={sidebarExpanded}
                label={t(item.labelKey)}
              />
            ))}
          </TooltipProvider>
        </nav>
        {(taskRunning || downloadPill) && (
          <div className="mt-auto flex flex-col gap-1 px-2 pb-1">
            {taskRunning && (
              <button
                type="button"
                onClick={() => router.push(`/${locale}/recent-tasks`)}
                aria-label={t('taskRunningPill.aria')}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2 py-1.5 text-[11px] text-primary transition-colors hover:bg-primary/10',
                  sidebarExpanded ? '' : 'justify-center',
                )}
              >
                <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                {sidebarExpanded && (
                  <span className="truncate">{t('taskRunningPill.label')}</span>
                )}
              </button>
            )}
            {downloadPill && (
              <button
                type="button"
                onClick={() => router.push(`/${locale}/engines`)}
                aria-label={t('downloadPill.aria')}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-full border px-2 py-1.5 text-[11px] transition-colors',
                  sidebarExpanded ? '' : 'justify-center',
                  downloadPill.status === 'error'
                    ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {downloadPill.status === 'error' ? (
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                ) : downloadPill.status === 'completed' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                )}
                {sidebarExpanded && (
                  <span className="truncate">
                    {downloadPill.status === 'completed'
                      ? t('downloadPill.done', { model: downloadPill.model })
                      : downloadPill.status === 'error'
                        ? t('downloadPill.failed', {
                            model: downloadPill.model,
                          })
                        : downloadPill.status === 'extracting'
                          ? t('downloadPill.extracting', {
                              model: downloadPill.model,
                            })
                          : `${downloadPill.model} ${Math.round(downloadPill.progress)}%`}
                  </span>
                )}
              </button>
            )}
          </div>
        )}
        <nav
          className={cn(
            'p-2 flex gap-1',
            !taskRunning && !downloadPill && 'mt-auto',
            sidebarExpanded
              ? 'flex-row items-center justify-between'
              : 'flex-col items-center',
          )}
        >
          <ThemeToggle />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    sidebarExpanded
                      ? t('sidebar.collapse')
                      : t('sidebar.expand')
                  }
                  onClick={() => setSidebarExpanded(!sidebarExpanded)}
                >
                  {sidebarExpanded ? (
                    <PanelLeftClose className="h-5 w-5" />
                  ) : (
                    <PanelLeftOpen className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                {sidebarExpanded ? t('sidebar.collapse') : t('sidebar.expand')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </nav>
      </aside>
      {/* min-w-0：阻止 grid 子项被内容最小宽度撑开，避免侧边栏展开后出现页面级横向滚动条 */}
      <div className="flex min-w-0 flex-col h-screen">
        <header className="flex-shrink-0 z-10 flex h-[57px] items-center gap-1 border-b bg-background px-4 overflow-hidden">
          <h4 className="text-base font-semibold">
            {t('headerTitle')}{' '}
            <span className="text-xs text-muted-foreground ml-2">
              v{packageInfo.version}
              {updateAvailable && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        className="ml-2 cursor-pointer border-primary/40 bg-primary/10 px-1.5 py-0 text-[11px] font-medium text-primary hover:bg-primary/20"
                        variant="outline"
                        onClick={handleUpdateClick}
                      >
                        {t('newVersionBadge', { version: newVersion })}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('newVersionAvailable')}: {newVersion}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </span>
          </h4>
          <div className="ml-auto flex items-center gap-1">
            {/* 加速状态指示器（加速=正向绿徽章，CPU=中性灯） */}
            {accelBadge && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`h-7 text-xs gap-1.5 ${
                        accelBadge.mode === 'accel'
                          ? 'text-success hover:text-success/80'
                          : accelBadge.mode === 'warning'
                            ? 'text-warning hover:text-warning/80'
                            : 'text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={() => {
                        // GPU 加速已折叠进 builtin 引擎面板：先选中 builtin（写 EngineModelTab
                        // 的选中态 localStorage），再跳「引擎与模型」页，落地直达 builtin 的加速区。
                        try {
                          localStorage.setItem(
                            'engineModelSelectedView',
                            JSON.stringify('builtin'),
                          );
                        } catch {
                          // 忽略：localStorage 不可用时仍跳转，EngineModelTab 回落默认 builtin
                        }
                        router.push(`/${locale}/engines`);
                      }}
                    >
                      <Zap className="w-3.5 h-3.5" />
                      {accelBadge.mode === 'accel'
                        ? accelBadge.label
                          ? t('accelBadgeOn', { backend: accelBadge.label })
                          : t('gpuAccelerationEnabled')
                        : accelBadge.mode === 'pending'
                          ? t('accelBadgePending', {
                              mode: gpuModeLabel(accelBadge.gpuMode),
                            })
                          : accelBadge.mode === 'warning'
                            ? t('accelBadgeGpuOnlyConflict')
                            : t('cpuModeBadge')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {accelBadge.mode === 'accel'
                        ? t('gpuAccelerationEnabledTip')
                        : accelBadge.mode === 'pending'
                          ? t('accelBadgePendingTip')
                          : accelBadge.mode === 'warning'
                            ? t('accelBadgeGpuOnlyConflictTip')
                            : t('cpuModeTip')}
                    </p>
                    <p className="text-muted-foreground">
                      {t('accelBadgeMode', {
                        mode: gpuModeLabel(accelBadge.gpuMode),
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label={t('help.menu')}
                >
                  <HelpCircle className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    onboardingPausedRef.current = false;
                    setOnboardingResumeStep(null);
                    openAfterMenuClose(() => setShowOnboarding(true));
                  }}
                >
                  <Compass className="mr-2 h-4 w-4" />
                  {t('help.reopenOnboarding')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    openAfterMenuClose(() => setShowShortcuts(true))
                  }
                >
                  <Keyboard className="mr-2 h-4 w-4" />
                  {t('help.shortcuts')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => openAfterMenuClose(() => setShowFaq(true))}
                >
                  <MessageCircleQuestion className="mr-2 h-4 w-4" />
                  {t('help.faq')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => openAfterMenuClose(() => setShowLogs(true))}
                >
                  <ScrollText className="mr-2 h-4 w-4" />
                  {t('viewLogs')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={checkUpdatesManually}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('help.checkUpdates')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => openUrl('https://github.com/buxuku/SmartSub')}
                >
                  <Github className="mr-2 h-4 w-4" />
                  {t('help.github')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 min-h-0 overflow-auto">{children}</main>
        <Toaster />
      </div>

      {/* 引导暂停后的「继续」悬浮入口 */}
      {onboardingResumeStep !== null && !showOnboarding && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-full border bg-background/95 px-1.5 py-1 shadow-lg backdrop-blur">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-full text-xs"
            onClick={() => setShowOnboarding(true)}
          >
            <Compass className="h-3.5 w-3.5" />
            {t('onboarding.resume')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-full text-muted-foreground"
            aria-label={t('onboarding.resumeDismiss')}
            onClick={dismissOnboardingResume}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Update Dialog */}
      <UpdateDialog
        open={showUpdateDialog}
        onOpenChange={setShowUpdateDialog}
        version={newVersion}
        releaseNotes={releaseNotes}
      />
      <LogDialog open={showLogs} onOpenChange={setShowLogs} />
      <ShortcutsHelpDialog
        open={showShortcuts}
        onOpenChange={setShowShortcuts}
      />
      <FaqDialog open={showFaq} onOpenChange={setShowFaq} />
      <OnboardingDialog
        open={showOnboarding}
        onOpenChange={handleOnboardingOpenChange}
        initialStep={onboardingResumeStep ?? 0}
        onPause={handleOnboardingPause}
      />
    </div>
  );
};

export default Layout;
