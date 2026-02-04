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
  BotIcon,
  FileVideo2,
  Github,
  MonitorPlay,
  Languages,
  Settings,
  Rocket,
  Edit3,
  Film,
  Zap,
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
  const [showAddonPrompt, setShowAddonPrompt] = useState(false);

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

    // 检查是否需要显示加速包下载提示
    const checkAddonStatus = async () => {
      try {
        const cudaEnv = await window?.ipc?.invoke('get-cuda-environment');
        const addonSummary = await window?.ipc?.invoke('get-addon-summary');

        // 如果支持 CUDA 但没有安装任何加速包，显示提示
        if (
          cudaEnv?.recommendation?.canUseCuda &&
          !addonSummary?.hasInstalled
        ) {
          setShowAddonPrompt(true);
        } else {
          setShowAddonPrompt(false);
        }
      } catch (error) {
        console.error('Failed to check addon status:', error);
      }
    };

    checkAddonStatus();

    // 清理函数
    return () => {
      cleanupMessage?.();
      cleanupUpdateStatus?.();
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
                <Link href={`/${locale}/modelsControl`}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`rounded-lg ${
                      asPath.includes('modelsControl') ? 'bg-muted' : ''
                    }`}
                    aria-label="Models"
                  >
                    <BotIcon className="size-5" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                {t('modelManagement')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={`/${locale}/translateControl`}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`rounded-lg ${
                      asPath.includes('translateControl') ? 'bg-muted' : ''
                    }`}
                    aria-label="Translate"
                  >
                    <Languages className="size-5" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={5}>
                {t('translationManagement')}
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
          {/* GPU 加速包下载提示 - 放在最右侧 */}
          {showAddonPrompt && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() =>
                      router.push(`/${locale}/settings#gpu-acceleration`)
                    }
                  >
                    <Zap className="w-4 h-4 mr-1 text-yellow-500" />
                    {t('downloadAccelerationPack')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('downloadAccelerationPackTip')}
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
