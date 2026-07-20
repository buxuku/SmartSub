import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import {
  Trash2,
  Cog,
  ChevronDown,
  Eraser,
  Activity,
  Download,
  Upload,
  Info,
  RefreshCw,
  Github,
  Globe,
  MessageSquareWarning,
  ScrollText,
  FolderOpen,
  SlidersHorizontal,
  RotateCcw,
  Server,
  X,
  HardDrive,
  ExternalLink,
  TriangleAlert,
  Check,
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import PageHeader from '@/components/PageHeader';
import HelpHint from '@/components/HelpHint';
import IconChip from '@/components/IconChip';
import { openUrl } from 'lib/utils';
import packageInfo from '../../../package.json';
import {
  DEFAULT_DOWNLOAD_ENDPOINTS,
  EDITABLE_DOWNLOAD_ENDPOINT_KEYS,
  normalizeDownloadEndpoints,
  type DownloadEndpointConfig,
} from '../../../types/downloadConfig';
import {
  containsCjk,
  validateStoragePath,
} from '../../../types/pathValidation';
import { invalidateDownloadEndpointsCache } from 'hooks/useDownloadEndpoints';

// 三档 VAD 环境预设。数值依据：标准=whisper.cpp 官方默认；
// 安静=silero 0.3-0.4 灵敏区+短语保留；嘈杂=whisper.rn noisyEnv 推荐
interface VadPreset {
  id: 'Quiet' | 'Standard' | 'Noisy';
  values: {
    vadThreshold: number;
    vadMinSpeechDuration: number;
    vadMinSilenceDuration: number;
    vadMaxSpeechDuration: number;
    vadSpeechPad: number;
    vadSamplesOverlap: number;
  };
}

const VAD_PRESETS: VadPreset[] = [
  {
    id: 'Quiet',
    values: {
      vadThreshold: 0.35,
      vadMinSpeechDuration: 100,
      vadMinSilenceDuration: 100,
      vadMaxSpeechDuration: 0,
      vadSpeechPad: 200,
      vadSamplesOverlap: 0.1,
    },
  },
  {
    id: 'Standard',
    values: {
      vadThreshold: 0.5,
      vadMinSpeechDuration: 250,
      vadMinSilenceDuration: 100,
      vadMaxSpeechDuration: 0,
      vadSpeechPad: 200,
      vadSamplesOverlap: 0.1,
    },
  },
  {
    id: 'Noisy',
    values: {
      vadThreshold: 0.65,
      vadMinSpeechDuration: 400,
      vadMinSilenceDuration: 150,
      vadMaxSpeechDuration: 0,
      vadSpeechPad: 150,
      vadSamplesOverlap: 0.1,
    },
  },
];
const STANDARD_PRESET = VAD_PRESETS[1];

// 常见代理软件的默认 HTTP 代理端口，供「自定义代理」一键填入。
// 仅列 HTTP(S) 代理（底层用 http(s)-proxy-agent，不支持 socks），免去用户记端口。
const PROXY_PRESETS: { label: string; url: string }[] = [
  { label: 'Clash', url: 'http://127.0.0.1:7890' },
  { label: 'V2Ray', url: 'http://127.0.0.1:10809' },
  { label: 'SS/SSR', url: 'http://127.0.0.1:1087' },
  { label: 'Surge', url: 'http://127.0.0.1:6152' },
];

const Settings = () => {
  const router = useRouter();
  const { t, i18n } = useTranslation('settings');
  const [currentLanguage, setCurrentLanguage] = useState(router.locale);
  const [tempDir, setTempDir] = useState('');
  const [customTempDir, setCustomTempDir] = useState('');
  const [useCustomTempDir, setUseCustomTempDir] = useState(false);
  const [storageRoot, setStorageRoot] = useState('');
  const [userDataPath, setUserDataPath] = useState('');
  // 换目录成功后的「新旧位置对照」对话框（手动迁移引导，design D9）
  const [storageMoveDialog, setStorageMoveDialog] = useState<{
    oldBase: string;
    newBase: string;
  } | null>(null);
  const [checkUpdateOnStartup, setCheckUpdateOnStartup] = useState(true);
  const [preventSleepDuringTask, setPreventSleepDuringTask] = useState(true);
  const [vadThreshold, setVADThreshold] = useState(0.5);
  const [vadMinSpeechDuration, setVADMinSpeechDuration] = useState(250);
  const [vadMinSilenceDuration, setVADMinSilenceDuration] = useState(100);
  const [vadMaxSpeechDuration, setVADMaxSpeechDuration] = useState(0);
  const [vadSpeechPad, setVADSpeechPad] = useState(200);
  const [vadSamplesOverlap, setVADSamplesOverlap] = useState(0.1);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [proxyMode, setProxyMode] = useState<'none' | 'custom'>('none');
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyNoProxy, setProxyNoProxy] = useState('');
  const [proxyTesting, setProxyTesting] = useState(false);
  const [downloadEndpointsOpen, setDownloadEndpointsOpen] = useState(false);
  const [downloadEndpoints, setDownloadEndpoints] =
    useState<DownloadEndpointConfig>(DEFAULT_DOWNLOAD_ENDPOINTS);
  const [closeAction, setCloseAction] = useState<
    'smart' | 'background' | 'quit'
  >('smart');
  // 关闭行为设置仅 macOS 有意义；用 useEffect 设置避免 SSR/CSR 水合不一致
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(window?.ipc?.platform === 'darwin');
  }, []);
  const form = useForm({
    defaultValues: {
      language: router.locale,
    },
  });

  useEffect(() => {
    const loadSettings = async () => {
      const settings = await window?.ipc?.invoke('getSettings');
      if (settings) {
        form.reset(settings);
        setCurrentLanguage(settings.language || router.locale);
        setUseCustomTempDir(settings.useCustomTempDir || false);
        setCustomTempDir(settings.customTempDir || '');
        setStorageRoot(settings.storageRoot || '');
        setCheckUpdateOnStartup(settings.checkUpdateOnStartup !== false);
        setPreventSleepDuringTask(settings.preventSleepDuringTask !== false);
        setVADThreshold(settings.vadThreshold ?? 0.5);
        setVADMinSpeechDuration(settings.vadMinSpeechDuration ?? 250);
        setVADMinSilenceDuration(settings.vadMinSilenceDuration ?? 100);
        setVADMaxSpeechDuration(settings.vadMaxSpeechDuration ?? 0);
        setVADSpeechPad(settings.vadSpeechPad ?? 200);
        setVADSamplesOverlap(settings.vadSamplesOverlap ?? 0.1);
        setProxyMode(settings.proxyMode === 'custom' ? 'custom' : 'none');
        setProxyUrl(settings.proxyUrl || '');
        setProxyNoProxy(settings.proxyNoProxy || '');
        setDownloadEndpoints(
          normalizeDownloadEndpoints(settings.downloadEndpoints),
        );
        setCloseAction(settings.closeAction || 'smart');
      }

      // 获取临时目录路径
      const tempDirPath = await window?.ipc?.invoke('getTempDir');
      setTempDir(tempDirPath || '');

      // userData 默认基座：用于「默认路径含中文」警示（design D6-3）
      const systemInfo = await window?.ipc?.invoke('getSystemInfo');
      setUserDataPath(systemInfo?.userDataPath || '');
    };
    loadSettings();
  }, []);

  useEffect(() => {
    setCurrentLanguage(i18n.language);
  }, [i18n.language]);

  const handleLanguageChange = async (value) => {
    await window?.ipc?.invoke('setSettings', { language: value });
    if (value !== i18n.language) {
      router.push(`/${value}/settings`);
    }
  };

  const handleClearConfig = async () => {
    const result = await window?.ipc?.invoke('clearConfig');
    if (result) {
      router.push(`/${i18n.language}/home`);
      toast.success(t('restoreDefaultsSuccess'));
    } else {
      toast.error(t('restoreDefaultsFailed'));
    }
  };

  // 有效临时目录随统一目录/自定义开关变化，操作后刷新展示
  const refreshTempDir = async () => {
    const tempDirPath = await window?.ipc?.invoke('getTempDir');
    setTempDir(tempDirPath || '');
  };

  // 选择自定义临时目录（先过中文路径硬校验，design D6）
  const handleSelectCustomTempDir = async () => {
    const result = await window?.ipc?.invoke('selectDirectory');
    if (result.canceled) return;

    const selectedPath = result.directoryPath;
    if (!validateStoragePath(selectedPath).ok) {
      toast.error(t('pathContainsCjkError'));
      return;
    }
    setCustomTempDir(selectedPath);

    try {
      await window?.ipc?.invoke('setSettings', {
        customTempDir: selectedPath,
        useCustomTempDir: true,
      });
      setUseCustomTempDir(true);
      toast.success(t('tempDirSaved'));
      void refreshTempDir();
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  // 切换是否使用自定义临时目录
  const handleCustomTempDirChange = async (checked: boolean) => {
    setUseCustomTempDir(checked);
    try {
      await window?.ipc?.invoke('setSettings', { useCustomTempDir: checked });
      toast.success(
        checked ? t('useCustomTempDirEnabled') : t('useCustomTempDirDisabled'),
      );
      void refreshTempDir();
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  // 选择统一存储根目录（中文路径硬校验，design D6；不迁移+对照引导，design D9）
  const handleSelectStorageRoot = async () => {
    const result = await window?.ipc?.invoke('selectDirectory');
    if (result.canceled) return;

    const selectedPath = result.directoryPath;
    if (!validateStoragePath(selectedPath).ok) {
      toast.error(t('pathContainsCjkError'));
      return;
    }
    try {
      const oldBase = storageRoot || userDataPath;
      await window?.ipc?.invoke('setSettings', { storageRoot: selectedPath });
      setStorageRoot(selectedPath);
      if (oldBase && oldBase !== selectedPath) {
        setStorageMoveDialog({ oldBase, newBase: selectedPath });
      } else {
        toast.success(t('storageRootSaved'), {
          description: t('storageRootNoMigrateHint'),
        });
      }
      void refreshTempDir();
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  // 清除统一存储根目录（恢复跟随系统默认）
  const handleClearStorageRoot = async () => {
    try {
      const oldBase = storageRoot;
      await window?.ipc?.invoke('setSettings', { storageRoot: '' });
      setStorageRoot('');
      if (oldBase && userDataPath && oldBase !== userDataPath) {
        setStorageMoveDialog({ oldBase, newBase: userDataPath });
      } else {
        toast.success(t('storageRootCleared'), {
          description: t('storageRootNoMigrateHint'),
        });
      }
      void refreshTempDir();
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  const handleOpenOldStorageBase = async () => {
    if (!storageMoveDialog) return;
    const result = await window?.ipc?.invoke('openDirectoryPath', {
      path: storageMoveDialog.oldBase,
    });
    if (!result?.success) {
      toast.error(t('openOldDirFailed'));
    }
  };

  const handleOpenStorageRoot = async () => {
    await window?.ipc?.invoke('openStorageRoot');
  };

  // 默认存储基座含中文且未设置统一目录：常驻警示引导（design D6-3）
  const showDefaultCjkWarning = !storageRoot && containsCjk(userDataPath);

  // 切换启动时检查更新
  const handleCheckUpdateOnStartupChange = async (checked: boolean) => {
    setCheckUpdateOnStartup(checked);
    try {
      await window?.ipc?.invoke('setSettings', {
        checkUpdateOnStartup: checked,
      });
      toast.success(
        checked
          ? t('checkUpdateOnStartupEnabled')
          : t('checkUpdateOnStartupDisabled'),
      );
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  const handlePreventSleepDuringTaskChange = async (checked: boolean) => {
    setPreventSleepDuringTask(checked);
    try {
      await window?.ipc?.invoke('setSettings', {
        preventSleepDuringTask: checked,
      });
      toast.success(
        checked
          ? t('preventSleepDuringTaskEnabled')
          : t('preventSleepDuringTaskDisabled'),
      );
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  // 添加清除缓存函数
  const handleClearCache = async () => {
    try {
      const result = await window?.ipc?.invoke('clearCache');
      if (result) {
        toast.success(t('cacheClearedSuccess'));
      } else {
        toast.error(t('cacheClearedFailed'));
      }
    } catch (error) {
      toast.error(t('cacheClearedFailed'));
    }
  };

  const handleCloseActionChange = async (
    value: 'smart' | 'background' | 'quit',
  ) => {
    setCloseAction(value);
    try {
      await window?.ipc?.invoke('setSettings', { closeAction: value });
      toast.success(t('closeActionSaved'));
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  // VAD 数字输入降噪：本地即时生效，500ms 静默期后批量持久化；成功静默，失败才打扰
  const pendingVadRef = useRef<Record<string, number>>({});
  const vadSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleVADSettingChange = (setting: string, value: number) => {
    const settingMap = {
      vadThreshold: setVADThreshold,
      vadMinSpeechDuration: setVADMinSpeechDuration,
      vadMinSilenceDuration: setVADMinSilenceDuration,
      vadMaxSpeechDuration: setVADMaxSpeechDuration,
      vadSpeechPad: setVADSpeechPad,
      vadSamplesOverlap: setVADSamplesOverlap,
    };

    settingMap[setting]?.(value);

    pendingVadRef.current[setting] = value;
    if (vadSaveTimerRef.current) clearTimeout(vadSaveTimerRef.current);
    vadSaveTimerRef.current = setTimeout(async () => {
      const pending = pendingVadRef.current;
      pendingVadRef.current = {};
      vadSaveTimerRef.current = null;
      try {
        await window?.ipc?.invoke('setSettings', pending);
      } catch (error) {
        toast.error(t('saveFailed'));
      }
    }, 500);
  };

  // 应用预设：逐键走 handleVADSettingChange，复用本地更新 + debounce 持久化
  const applyVadPreset = (preset: VadPreset) => {
    Object.entries(preset.values).forEach(([key, value]) => {
      handleVADSettingChange(key, value);
    });
  };

  const isPresetActive = (preset: VadPreset) =>
    vadThreshold === preset.values.vadThreshold &&
    vadMinSpeechDuration === preset.values.vadMinSpeechDuration &&
    vadMinSilenceDuration === preset.values.vadMinSilenceDuration &&
    vadMaxSpeechDuration === preset.values.vadMaxSpeechDuration &&
    vadSpeechPad === preset.values.vadSpeechPad &&
    vadSamplesOverlap === preset.values.vadSamplesOverlap;

  const saveProxy = async (
    patch: Partial<{
      proxyMode: 'none' | 'custom';
      proxyUrl: string;
      proxyNoProxy: string;
    }>,
  ) => {
    try {
      await window?.ipc?.invoke('setSettings', patch);
      toast.success(t('proxySaved'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const handleProxyModeChange = (mode: 'none' | 'custom') => {
    setProxyMode(mode);
    void saveProxy({ proxyMode: mode });
  };

  const handleProxyUrlBlur = () => {
    void saveProxy({ proxyUrl, proxyNoProxy });
  };

  const handleProxyPresetSelect = (url: string) => {
    setProxyUrl(url);
    void saveProxy({ proxyUrl: url, proxyNoProxy });
  };

  const handleProxyTest = async () => {
    setProxyTesting(true);
    try {
      // 先持久化当前输入，确保测试用的是最新代理
      await window?.ipc?.invoke('setSettings', {
        proxyMode,
        proxyUrl,
        proxyNoProxy,
      });
      const result = await window?.ipc?.invoke('proxy:test');
      if (result?.ok) {
        toast.success(t('proxyTestOk', { ms: result.ms }));
      } else {
        toast.error(t('proxyTestFail', { error: result?.error || 'unknown' }));
      }
    } catch (e) {
      toast.error(
        t('proxyTestFail', { error: e instanceof Error ? e.message : 'error' }),
      );
    } finally {
      setProxyTesting(false);
    }
  };

  // 下载源端点：onChange 仅更新本地原始值，onBlur 规范化后持久化（仅存可编辑字段）。
  const handleEndpointChange = (
    key: keyof DownloadEndpointConfig,
    value: string,
  ) => {
    setDownloadEndpoints((prev) => ({ ...prev, [key]: value }));
  };

  const persistDownloadEndpoints = async (next: DownloadEndpointConfig) => {
    const normalized = normalizeDownloadEndpoints(next);
    setDownloadEndpoints(normalized);
    const overrides: Partial<DownloadEndpointConfig> = {};
    EDITABLE_DOWNLOAD_ENDPOINT_KEYS.forEach((key) => {
      overrides[key] = normalized[key];
    });
    try {
      await window?.ipc?.invoke('setSettings', {
        downloadEndpoints: overrides,
      });
      invalidateDownloadEndpointsCache();
      toast.success(t('downloadEndpointsSaved'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const handleEndpointBlur = () => {
    void persistDownloadEndpoints(downloadEndpoints);
  };

  const handleEndpointsReset = async () => {
    setDownloadEndpoints(DEFAULT_DOWNLOAD_ENDPOINTS);
    try {
      await window?.ipc?.invoke('setSettings', { downloadEndpoints: {} });
      invalidateDownloadEndpointsCache();
      toast.success(t('downloadEndpointsResetDone'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportConfirmPassword, setExportConfirmPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const handleExport = async () => {
    if (!exportPassword) {
      toast.error(t('passwordRequired'));
      return;
    }
    if (exportPassword !== exportConfirmPassword) {
      toast.error(t('passwordMismatch'));
      return;
    }
    setIsExporting(true);
    try {
      const result = await window?.ipc?.invoke('exportConfig', exportPassword);
      if (result?.success) {
        toast.success(t('exportSuccess'));
        setExportDialogOpen(false);
        setExportPassword('');
        setExportConfirmPassword('');
      } else if (result?.error === 'canceled') {
        toast.info(t('exportCanceled'));
      } else {
        toast.error(t('exportFailed'));
      }
    } catch {
      toast.error(t('exportFailed'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async () => {
    if (!importPassword) {
      toast.error(t('passwordRequired'));
      return;
    }
    setIsImporting(true);
    try {
      const result = await window?.ipc?.invoke('importConfig', importPassword);
      if (result?.success) {
        toast.success(t('importSuccess'));
        setImportDialogOpen(false);
        setImportPassword('');
      } else if (result?.error === 'canceled') {
        toast.info(t('importCanceled'));
      } else if (result?.error === 'invalidPassword') {
        toast.error(t('invalidPassword'));
      } else if (result?.error === 'invalidConfigFile') {
        toast.error(t('invalidConfigFile'));
      } else {
        toast.error(t('importFailed'));
      }
    } catch {
      toast.error(t('importFailed'));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-4xl space-y-2.5 p-3">
        <PageHeader title={t('settings')} description={t('settingsDesc')} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconChip icon={Cog} />
              {t('systemSettings')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span>{t('changeLanguage')}</span>
              <Select
                onValueChange={handleLanguageChange}
                value={currentLanguage}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder={t('selectLanguage')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zh">{t('chinese')}</SelectItem>
                  <SelectItem value="en">{t('english')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>{t('checkUpdateOnStartup')}</span>
                <HelpHint text={t('checkUpdateOnStartupTip')} />
              </div>
              <Switch
                checked={checkUpdateOnStartup}
                onCheckedChange={handleCheckUpdateOnStartupChange}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>{t('preventSleepDuringTask')}</span>
                <HelpHint text={t('preventSleepDuringTaskTip')} />
              </div>
              <Switch
                checked={preventSleepDuringTask}
                onCheckedChange={handlePreventSleepDuringTaskChange}
              />
            </div>

            {isMac && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span>{t('closeAction')}</span>
                  <HelpHint text={t('closeActionTip')} />
                </div>
                <Select
                  value={closeAction}
                  onValueChange={(v) =>
                    handleCloseActionChange(
                      v as 'smart' | 'background' | 'quit',
                    )
                  }
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="smart">
                      {t('closeActionSmart')}
                    </SelectItem>
                    <SelectItem value="background">
                      {t('closeActionBackground')}
                    </SelectItem>
                    <SelectItem value="quit">{t('closeActionQuit')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconChip icon={HardDrive} />
              {t('storageLocationTitle')}
            </CardTitle>
            <p className="text-sm text-muted-foreground pt-1">
              {t('storageLocationDesc')}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {showDefaultCjkWarning && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  {t('defaultPathCjkWarning', { path: userDataPath })}
                </span>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span>{t('storageRoot')}</span>
                <HelpHint text={t('storageRootTip')} />
              </div>
              <div className="flex gap-2">
                {/* 未设置时回显 userData 默认基座（弱化配色区分「跟随默认」与「已设置」） */}
                <Input
                  value={storageRoot || userDataPath}
                  readOnly
                  className={`font-mono text-sm flex-1 ${
                    storageRoot ? '' : 'text-muted-foreground'
                  }`}
                  placeholder={t('storageRootPlaceholder')}
                />
                <Button
                  onClick={handleSelectStorageRoot}
                  size="sm"
                  className="flex-shrink-0 gap-1.5"
                >
                  <FolderOpen className="h-4 w-4" />
                  {t('selectPath')}
                </Button>
                <Button
                  onClick={handleOpenStorageRoot}
                  variant="outline"
                  size="sm"
                  className="flex-shrink-0 gap-1.5"
                >
                  <ExternalLink className="h-4 w-4" />
                  {t('openStorageRoot')}
                </Button>
                {storageRoot && (
                  <Button
                    onClick={handleClearStorageRoot}
                    variant="outline"
                    size="sm"
                    className="flex-shrink-0 gap-1.5"
                  >
                    <RotateCcw className="h-4 w-4" />
                    {t('storageRootClear')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('storageRootHint')}
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span>{t('tempDir')}</span>
                <HelpHint text={t('tempDirTip')} />
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <span>{t('useCustomTempDir')}</span>
                  <Switch
                    checked={useCustomTempDir}
                    onCheckedChange={handleCustomTempDirChange}
                  />
                </div>

                {useCustomTempDir ? (
                  <div className="flex gap-2">
                    <Input
                      value={customTempDir}
                      readOnly
                      className="font-mono text-sm flex-1"
                      placeholder={t('customTempDirPlaceholder')}
                    />
                    <Button
                      onClick={handleSelectCustomTempDir}
                      size="sm"
                      className="flex-shrink-0 gap-1.5"
                    >
                      <FolderOpen className="h-4 w-4" />
                      {t('selectPath')}
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      value={tempDir}
                      readOnly
                      className="font-mono text-sm flex-1"
                      placeholder={t('tempDirPlaceholder')}
                    />
                    <Button
                      onClick={handleClearCache}
                      size="sm"
                      className="flex-shrink-0 gap-1.5"
                    >
                      <Eraser className="h-4 w-4" />
                      {t('clearCache')}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconChip icon={Globe} />
              {t('proxyTitle')}
            </CardTitle>
            <p className="text-sm text-muted-foreground pt-1">
              {t('proxyDesc')}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span>{t('proxyMode')}</span>
              <Select
                value={proxyMode}
                onValueChange={(v) =>
                  handleProxyModeChange(v as 'none' | 'custom')
                }
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('proxyModeNone')}</SelectItem>
                  <SelectItem value="custom">{t('proxyModeCustom')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {proxyMode === 'custom' && (
              <>
                <div className="space-y-2">
                  <span>{t('proxyUrl')}</span>
                  <Input
                    value={proxyUrl}
                    onChange={(e) => setProxyUrl(e.target.value)}
                    onBlur={handleProxyUrlBlur}
                    placeholder={t('proxyUrlPlaceholder')}
                    className="font-mono text-sm"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {t('proxyQuickFill')}
                    </span>
                    {PROXY_PRESETS.map((preset) => (
                      <Button
                        key={preset.label}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs font-normal"
                        onClick={() => handleProxyPresetSelect(preset.url)}
                        title={preset.url}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <span>{t('proxyNoProxy')}</span>
                  <Input
                    value={proxyNoProxy}
                    onChange={(e) => setProxyNoProxy(e.target.value)}
                    onBlur={handleProxyUrlBlur}
                    placeholder={t('proxyNoProxyPlaceholder')}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleProxyTest}
                    disabled={proxyTesting}
                  >
                    <Activity className="h-4 w-4" />
                    {proxyTesting ? t('proxyTesting') : t('proxyTest')}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <Collapsible
            open={downloadEndpointsOpen}
            onOpenChange={setDownloadEndpointsOpen}
          >
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <CardTitle className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <IconChip icon={Server} />
                    {t('downloadEndpointsTitle')}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${
                      downloadEndpointsOpen ? 'rotate-180' : ''
                    }`}
                  />
                </CardTitle>
                <p className="text-sm text-muted-foreground pt-1">
                  {t('downloadEndpointsDesc')}
                </p>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-4">
                {EDITABLE_DOWNLOAD_ENDPOINT_KEYS.map((key) => (
                  <div className="space-y-2" key={key}>
                    <div className="flex items-center gap-2">
                      <span>{t(`downloadEndpointFields.${key}.label`)}</span>
                      <HelpHint
                        text={t(`downloadEndpointFields.${key}.hint`)}
                      />
                    </div>
                    <Input
                      value={downloadEndpoints[key]}
                      onChange={(e) =>
                        handleEndpointChange(key, e.target.value)
                      }
                      onBlur={handleEndpointBlur}
                      placeholder={DEFAULT_DOWNLOAD_ENDPOINTS[key]}
                      className="font-mono text-sm"
                    />
                  </div>
                ))}
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleEndpointsReset}
                  >
                    <RotateCcw className="h-4 w-4" />
                    {t('downloadEndpointsResetBtn')}
                  </Button>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>

        <Card>
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <CardTitle className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <IconChip icon={Activity} />
                    {t('vadSettings')}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${
                      advancedOpen ? 'rotate-180' : ''
                    }`}
                  />
                </CardTitle>
                <p className="text-sm text-muted-foreground pt-1">
                  {t('vadSettingsDesc')}
                </p>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t('vadSensitivityNote')}
                </p>

                {/* 三档环境预设：VAD 开/关由「字幕效果」档位决定，这里只调灵敏度；与手动微调共存，当前值与某档全等时高亮 */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('vadPresets')}
                  </span>
                  {VAD_PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      variant={isPresetActive(preset) ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => applyVadPreset(preset)}
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                      {t(`vadPreset${preset.id}`)}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={() => applyVadPreset(STANDARD_PRESET)}
                  >
                    <RotateCcw className="h-4 w-4" />
                    {t('vadPresetReset')}
                  </Button>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span>{t('vadThreshold')}</span>
                    <HelpHint text={t('vadThresholdTip')} />
                  </div>
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    max="1"
                    value={vadThreshold}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadThreshold',
                        Number(e.target.value),
                      )
                    }
                    className="font-mono text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span>{t('vadMinSpeechDuration')}</span>
                    <HelpHint text={t('vadMinSpeechDurationTip')} />
                  </div>
                  <Input
                    type="number"
                    min="0"
                    value={vadMinSpeechDuration}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadMinSpeechDuration',
                        Number(e.target.value),
                      )
                    }
                    className="font-mono text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span>{t('vadMinSilenceDuration')}</span>
                    <HelpHint text={t('vadMinSilenceDurationTip')} />
                  </div>
                  <Input
                    type="number"
                    min="0"
                    value={vadMinSilenceDuration}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadMinSilenceDuration',
                        Number(e.target.value),
                      )
                    }
                    className="font-mono text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span>{t('vadMaxSpeechDuration')}</span>
                    <HelpHint text={t('vadMaxSpeechDurationTip')} />
                  </div>
                  <Input
                    type="number"
                    min="0"
                    value={vadMaxSpeechDuration}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadMaxSpeechDuration',
                        Number(e.target.value),
                      )
                    }
                    className="font-mono text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span>{t('vadSpeechPad')}</span>
                    <HelpHint text={t('vadSpeechPadTip')} />
                  </div>
                  <Input
                    type="number"
                    min="0"
                    value={vadSpeechPad}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadSpeechPad',
                        Number(e.target.value),
                      )
                    }
                    className="font-mono text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span>{t('vadSamplesOverlap')}</span>
                    <HelpHint text={t('vadSamplesOverlapTip')} />
                  </div>
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    max="1"
                    value={vadSamplesOverlap}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadSamplesOverlap',
                        Number(e.target.value),
                      )
                    }
                    className="font-mono text-sm"
                  />
                </div>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconChip icon={Download} />
              {t('configImportExport')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('configImportExportDescription')}
            </p>
            <div className="flex gap-4">
              <Button
                onClick={() => setExportDialogOpen(true)}
                className="flex items-center gap-1.5"
              >
                <Upload className="h-4 w-4" />
                {t('exportConfig')}
              </Button>
              <Button
                onClick={() => setImportDialogOpen(true)}
                variant="outline"
                className="flex items-center gap-1.5"
              >
                <Download className="h-4 w-4" />
                {t('importConfig')}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Dialog
          open={exportDialogOpen}
          onOpenChange={(open) => {
            setExportDialogOpen(open);
            if (!open) {
              setExportPassword('');
              setExportConfirmPassword('');
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('enterPasswordForExport')}</DialogTitle>
              <DialogDescription>
                {t('enterPasswordForExportDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <Input
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
              />
              <Input
                type="password"
                placeholder={t('confirmPasswordPlaceholder')}
                value={exportConfirmPassword}
                onChange={(e) => setExportConfirmPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleExport();
                }}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => setExportDialogOpen(false)}
              >
                <X className="h-4 w-4" />
                {t('cancel')}
              </Button>
              <Button
                onClick={handleExport}
                disabled={isExporting}
                className="gap-1.5"
              >
                {isExporting ? (
                  t('exporting')
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    {t('confirm')}
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={importDialogOpen}
          onOpenChange={(open) => {
            setImportDialogOpen(open);
            if (!open) {
              setImportPassword('');
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('enterPasswordForImport')}</DialogTitle>
              <DialogDescription>
                {t('enterPasswordForImportDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <Input
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleImport();
                }}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => setImportDialogOpen(false)}
              >
                <X className="h-4 w-4" />
                {t('cancel')}
              </Button>
              <Button
                onClick={handleImport}
                disabled={isImporting}
                className="gap-1.5"
              >
                {isImporting ? (
                  t('importing')
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    {t('confirm')}
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 换存储目录后的新旧位置对照：子目录同名，手动迁移只需整体复制（design D9） */}
        <Dialog
          open={!!storageMoveDialog}
          onOpenChange={(open) => {
            if (!open) setStorageMoveDialog(null);
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{t('storageMoveDialogTitle')}</DialogTitle>
              <DialogDescription>
                {t('storageMoveDialogDesc')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">
                  {t('storageMoveOldDir')}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={storageMoveDialog?.oldBase || ''}
                    readOnly
                    className="font-mono text-sm flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-shrink-0 gap-1.5 self-center"
                    onClick={handleOpenOldStorageBase}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t('openOldDir')}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">
                  {t('storageMoveNewDir')}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={storageMoveDialog?.newBase || ''}
                    readOnly
                    className="font-mono text-sm flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-shrink-0 gap-1.5 self-center"
                    onClick={handleOpenStorageRoot}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t('openNewDir')}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('storageMoveOverrideNote')}
              </p>
            </div>
            <DialogFooter>
              <Button
                onClick={() => setStorageMoveDialog(null)}
                className="gap-1.5"
              >
                <Check className="h-4 w-4" />
                {t('storageMoveGotIt')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconChip icon={Info} />
              {t('about')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{t('common:headerTitle')}</div>
                <div className="font-mono text-sm text-muted-foreground">
                  v{packageInfo.version}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('app-check-updates'))
                }
              >
                <RefreshCw className="h-4 w-4" />
                {t('common:help.checkUpdates')}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 pt-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => openUrl('https://github.com/buxuku/SmartSub')}
              >
                <Github className="h-4 w-4" />
                {t('common:help.github')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={() =>
                  openUrl('https://github.com/buxuku/SmartSub/issues')
                }
              >
                <MessageSquareWarning className="h-4 w-4" />
                {t('common:help.reportIssue')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('app-open-logs'))
                }
              >
                <ScrollText className="h-4 w-4" />
                {t('common:viewLogs')}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <IconChip
                icon={Trash2}
                className="bg-destructive/10 text-destructive"
              />
              {t('dangerZone')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{t('restoreDefaults')}</div>
                <div className="text-sm text-muted-foreground">
                  {t('restoreDefaultsDescription')}
                </div>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="flex items-center gap-1.5 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('restore')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('restoreDefaults')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('restoreDefaultsDescription')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="gap-1.5">
                      <X className="h-4 w-4" />
                      {t('cancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleClearConfig}
                      className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('restore')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
};

export default Settings;

export const getStaticProps = makeStaticProperties([
  'common',
  'settings',
  'parameters',
  'resources',
]);

export { getStaticPaths };
