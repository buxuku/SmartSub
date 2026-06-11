import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Compass,
  Edit3,
  FileVideo2,
  Film,
  HelpCircle,
  MonitorPlay,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Rocket,
  Settings,
  X,
  Zap,
  ZapOff,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from './ThemeToggle';
import { cn, openUrl } from 'lib/utils';
import { useRouter } from 'next/router';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useTranslation } from 'next-i18next';
import { UpdateDialog } from './UpdateDialog';
import { LogDialog } from './LogDialog';
import OnboardingDialog from './onboarding/OnboardingDialog';
import useLocalStorageState from 'hooks/useLocalStorageState';
import packageInfo from '../../package.json';

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
    href: 'resources',
    labelKey: 'resourceCenter',
    icon: Package,
    isActive: (p) => p.includes('resources'),
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

const Layout = ({ children }) => {
  const {
    t,
    i18n: { language: locale },
  } = useTranslation('common');
  const router = useRouter();
  const { asPath } = router;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [newVersion, setNewVersion] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [gpuCapable, setGpuCapable] = useState(false);
  const [gpuEnabled, setGpuEnabled] = useState(false);
  const [gpuBackendLabel, setGpuBackendLabel] = useState('');
  const [showLogs, setShowLogs] = useState(false);
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

  useEffect(() => {
    // 首次启动（无已装模型且无完成标记）自动打开新手引导
    (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (settings?.onboardingCompleted || settings?.useLocalWhisper) return;
        const info = await window?.ipc?.invoke('getSystemInfo', null);
        if ((info?.modelsInstalled?.length ?? 0) === 0) {
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
      },
    );

    const backendLabels: Record<string, string> = {
      cuda: 'CUDA',
      vulkan: 'Vulkan',
      cpu: 'CPU',
      metal: 'Metal',
      coreml: 'CoreML',
      custom: 'Custom',
    };

    // 检查 GPU 加速状态
    const checkGpuStatus = async () => {
      try {
        const env = await window?.ipc?.invoke('get-gpu-environment');
        const capable = !!env && env.platform !== 'darwin';
        setGpuCapable(capable);
        if (!capable) return;

        const settings = await window?.ipc?.invoke('getSettings');
        const active = await window?.ipc?.invoke('get-active-backend');
        const isCpuResult = active?.backend === 'cpu';
        setGpuEnabled(settings?.gpuMode !== 'cpu-only' && !isCpuResult);
        setGpuBackendLabel(
          active && !isCpuResult
            ? active.backend === 'cuda' && active.variant
              ? `CUDA ${active.variant}`
              : backendLabels[active.backend] || active.backend
            : '',
        );
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

    // 清理函数
    return () => {
      cleanupMessage?.();
      cleanupUpdateStatus?.();
      cleanupFallback?.();
      cleanupBackendChanged?.();
      window.removeEventListener(
        'gpu-settings-changed',
        handleGpuSettingsChanged,
      );
    };
  }, [t]);

  const handleUpdateClick = () => {
    setShowUpdateDialog(true);
  };

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

  const sidebarWidth = sidebarExpanded ? 'w-[176px]' : 'w-[56px]';

  return (
    <div
      className={cn(
        'grid h-screen w-full transition-[padding-left] duration-200',
        sidebarExpanded ? 'pl-[176px]' : 'pl-[56px]',
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
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border bg-card">
              <FileVideo2 className="size-5" />
            </span>
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
        <nav
          className={cn(
            'mt-auto p-2 flex gap-1',
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
            <span className="text-xs text-gray-500 ml-2">
              v{packageInfo.version}
              {updateAvailable && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Rocket
                        className="ml-2 inline-block cursor-pointer text-red-500"
                        size={18}
                        onClick={handleUpdateClick}
                      />
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
            {/* GPU 加速状态指示器 */}
            {gpuCapable && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`h-7 text-xs gap-1.5 ${
                        gpuEnabled
                          ? 'text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={() =>
                        router.push(`/${locale}/resources?tab=acceleration`)
                      }
                    >
                      {gpuEnabled ? (
                        <Zap className="w-3.5 h-3.5" />
                      ) : (
                        <ZapOff className="w-3.5 h-3.5" />
                      )}
                      {gpuEnabled
                        ? `${t('gpuAccelerationEnabled')}${gpuBackendLabel ? ` · ${gpuBackendLabel}` : ''}`
                        : t('gpuAccelerationDisabled')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {gpuEnabled
                      ? t('gpuAccelerationEnabledTip')
                      : t('gpuAccelerationDisabledTip')}
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
                    setShowOnboarding(true);
                  }}
                >
                  {t('help.reopenOnboarding')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowLogs(true)}>
                  {t('viewLogs')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => openUrl('https://github.com/buxuku/SmartSub')}
                >
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
