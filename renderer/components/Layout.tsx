import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  FileVideo2,
  Github,
  MonitorPlay,
  Package,
  Settings,
  Rocket,
  Edit3,
  Film,
  Zap,
  ZapOff,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { openUrl } from 'lib/utils';
import { useRouter } from 'next/router';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useTranslation } from 'next-i18next';
import { UpdateDialog } from './UpdateDialog';
import packageInfo from '../../package.json';

// 添加更新状态的类型定义
interface UpdateStatus {
  status: string;
  version?: string;
  progress?: number;
  error?: string;
  releaseNotes?: string;
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

  return (
    <div className="grid h-screen w-full pl-[56px]">
      <aside className="inset-y fixed  left-0 z-20 flex h-full flex-col border-r">
        <div className="border-b p-2">
          <Link href={`/${locale}/home`}>
            <Button aria-label="Home" size="icon" variant="outline">
              <FileVideo2 className="size-5" />
            </Button>
          </Link>
        </div>
        <nav className="grid gap-1 p-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={`/${locale}/home`}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`rounded-lg ${
                      asPath.includes('home') ? 'bg-muted' : ''
                    }`}
                    aria-label="Playground"
                  >
                    <MonitorPlay className="size-5" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                {t('tasks')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={`/${locale}/proofread`}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`rounded-lg ${
                      asPath.includes('proofread') ? 'bg-muted' : ''
                    }`}
                    aria-label="Proofread"
                  >
                    <Edit3 className="size-5" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                {t('subtitleProofread')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={`/${locale}/subtitleMerge`}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`rounded-lg ${
                      asPath.includes('subtitleMerge') ? 'bg-muted' : ''
                    }`}
                    aria-label="Subtitle Merge"
                  >
                    <Film className="size-5" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                {t('subtitleMerge')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={`/${locale}/resources`}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`rounded-lg ${
                      asPath.includes('resources') ? 'bg-muted' : ''
                    }`}
                    aria-label="Resources"
                  >
                    <Package className="size-5" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                {t('resourceCenter')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={`/${locale}/settings`}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`rounded-lg ${
                      asPath.includes('settings') ? 'bg-muted' : ''
                    }`}
                    aria-label="Settings"
                  >
                    <Settings className="size-5" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                {t('settings')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </nav>
        <nav className="mt-auto grid gap-1 p-2">
          <ThemeToggle />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild className="w-10">
                <Github
                  onClick={() => openUrl('https://github.com/buxuku/SmartSub')}
                  className="size-5 inline-block cursor-pointer"
                />
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                Github
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </nav>
      </aside>
      <div className="flex flex-col h-screen">
        <header className="flex-shrink-0 z-10 flex h-[57px] items-center gap-1 border-b bg-background px-4">
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
          {/* GPU 加速状态指示器 */}
          {gpuCapable && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`ml-auto h-7 text-xs gap-1.5 ${
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
        </header>
        <main className="flex-1 min-h-0 overflow-auto">{children}</main>
        <Toaster />
      </div>

      {/* Update Dialog */}
      <UpdateDialog
        open={showUpdateDialog}
        onOpenChange={setShowUpdateDialog}
        version={newVersion}
        releaseNotes={releaseNotes}
      />
    </div>
  );
};

export default Layout;
