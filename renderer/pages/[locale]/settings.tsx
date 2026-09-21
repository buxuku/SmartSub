import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import CustomLanguageManager from '@/components/settings/CustomLanguageManager';
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
import { useSettingsPersistence } from '../../hooks/useSettingsPersistence';
import { useNavigationGuard } from '@/context/NavigationGuardContext';
import {
  sanitizeCustomLanguages,
  type CustomLanguage,
} from '../../../types/language';
import { supportedLanguage } from '../../lib/utils';
import { invalidVadSettings } from '../../../types/vadSettings';

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
  const { t: commonT } = useTranslation('common');
  const [operationError, setOperationError] = useState<{
    message: string;
    details: string;
    retry?: () => void;
  } | null>(null);
  const reportError = (message: string, cause?: unknown, retry?: () => void) =>
    setOperationError({
      message,
      details:
        cause instanceof Error ? cause.message : String(cause || message),
      retry,
    });
  const [currentLanguage, setCurrentLanguage] = useState(router.locale);
  const [customLanguages, setCustomLanguages] = useState<CustomLanguage[]>([]);
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
  const [vadThreshold, setVADThreshold] = useState<number | string>(0.5);
  const [vadMinSpeechDuration, setVADMinSpeechDuration] = useState<
    number | string
  >(250);
  const [vadMinSilenceDuration, setVADMinSilenceDuration] = useState<
    number | string
  >(100);
  const [vadMaxSpeechDuration, setVADMaxSpeechDuration] = useState<
    number | string
  >(0);
  const [vadSpeechPad, setVADSpeechPad] = useState<number | string>(200);
  const [vadSamplesOverlap, setVADSamplesOverlap] = useState<number | string>(
    0.1,
  );
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
  const persistence = useSettingsPersistence(
    (settings: any) => {
      setCustomLanguages(
        sanitizeCustomLanguages(
          settings.customLanguages,
          supportedLanguage.map((language) => language.value),
        ),
      );
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
    },
    (settings) => {
      invalidateDownloadEndpointsCache();
      const oldBase = storageRoot || userDataPath;
      const newBase = String(settings.storageRoot || userDataPath);
      if (oldBase && newBase && oldBase !== newBase)
        setStorageMoveDialog({ oldBase, newBase });
      if (
        typeof settings.language === 'string' &&
        settings.language !== i18n.language
      )
        void router
          .push(`/${settings.language}/settings`)
          .catch((cause) => reportError(t('saveFailed'), cause));
    },
  );
  useNavigationGuard('settings-save', {
    isDirty: persistence.isDirty,
    getIsDirty: persistence.getIsDirty,
    onSave: persistence.save,
    onDiscard: persistence.discard,
  });
  const [pathsError, setPathsError] = useState('');
  const pathsEpoch = useRef(0);
  useEffect(
    () => () => {
      pathsEpoch.current++;
    },
    [],
  );
  const loadPaths = useCallback(async () => {
    const version = ++pathsEpoch.current;
    try {
      const [directory, info] = await Promise.all([
        window.ipc.invoke('getTempDir'),
        window.ipc.invoke('getSystemInfo'),
      ]);
      if (version !== pathsEpoch.current) return;
      if (
        typeof directory !== 'string' ||
        typeof info?.userDataPath !== 'string'
      )
        throw new Error('INVALID_SETTINGS_PATH_RESPONSE');
      setTempDir(directory);
      setUserDataPath(info.userDataPath);
      setPathsError('');
    } catch (cause) {
      if (version !== pathsEpoch.current) return;
      setPathsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    if (persistence.loaded) void loadPaths();
  }, [
    persistence.loaded,
    loadPaths,
    storageRoot,
    customTempDir,
    useCustomTempDir,
  ]);

  useEffect(() => {
    setCurrentLanguage(i18n.language);
  }, [i18n.language]);

  const handleLanguageChange = async (value) => {
    await persistence.persist({ language: value });
  };

  const handleClearConfig = async () => {
    try {
      if (persistence.getIsDirty() && !(await persistence.save())) return;
      const result = await window.ipc.invoke('clearConfig');
      if (result !== true) throw new Error('CLEAR_CONFIG_FAILED');
      await router.push(`/${i18n.language}/home`);
      toast.success(t('restoreDefaultsSuccess'));
    } catch (cause) {
      reportError(t('restoreDefaultsFailed'), cause);
    }
  };

  // 有效临时目录随统一目录/自定义开关变化，操作后刷新展示
  const refreshTempDir = async () => {
    await loadPaths();
  };

  // 选择自定义临时目录（先过中文路径硬校验，design D6）
  const handleSelectCustomTempDir = async () => {
    try {
      const result = await window?.ipc?.invoke('selectDirectory');
      if (result.canceled) return;

      const selectedPath = result.directoryPath;
      if (!validateStoragePath(selectedPath).ok) {
        reportError(t('pathContainsCjkError'));
        return;
      }
      setCustomTempDir(selectedPath);

      if (
        !(await persistence.persist({
          customTempDir: selectedPath,
          useCustomTempDir: true,
        }))
      )
        return;
      setUseCustomTempDir(true);
      toast.success(t('tempDirSaved'));
      void refreshTempDir();
    } catch (error) {
      reportError(
        t('saveFailed'),
        error,
        () => void handleSelectCustomTempDir(),
      );
    }
  };

  // 切换是否使用自定义临时目录
  const handleCustomTempDirChange = async (checked: boolean) => {
    setUseCustomTempDir(checked);
    try {
      if (!(await persistence.persist({ useCustomTempDir: checked }))) return;
      toast.success(
        checked ? t('useCustomTempDirEnabled') : t('useCustomTempDirDisabled'),
      );
      void refreshTempDir();
    } catch (error) {
      reportError(t('saveFailed'), error);
    }
  };

  // 选择统一存储根目录（中文路径硬校验，design D6；不迁移+对照引导，design D9）
  const handleSelectStorageRoot = async () => {
    try {
      const result = await window?.ipc?.invoke('selectDirectory');
      if (result.canceled) return;

      const selectedPath = result.directoryPath;
      if (!validateStoragePath(selectedPath).ok) {
        reportError(t('pathContainsCjkError'));
        return;
      }
      if (!(await persistence.persist({ storageRoot: selectedPath }))) return;
      void refreshTempDir();
    } catch (error) {
      reportError(t('saveFailed'), error, () => void handleSelectStorageRoot());
    }
  };

  // 清除统一存储根目录（恢复跟随系统默认）
  const handleClearStorageRoot = async () => {
    try {
      if (!(await persistence.persist({ storageRoot: '' }))) return;
      void refreshTempDir();
    } catch (error) {
      reportError(t('saveFailed'), error);
    }
  };

  const handleOpenOldStorageBase = async () => {
    if (!storageMoveDialog) return;
    setOperationError(null);
    try {
      const result = await window?.ipc?.invoke('openDirectoryPath', {
        path: storageMoveDialog.oldBase,
      });
      if (!result?.success) {
        throw new Error(result?.error || t('openOldDirFailed'));
      }
    } catch (cause) {
      reportError(
        t('openOldDirFailed'),
        cause,
        () => void handleOpenOldStorageBase(),
      );
    }
  };

  const handleOpenStorageRoot = async () => {
    setOperationError(null);
    try {
      const result = await window?.ipc?.invoke('openStorageRoot');
      if (!result?.success)
        throw new Error(result?.error || t('openOldDirFailed'));
    } catch (cause) {
      reportError(
        t('openOldDirFailed'),
        cause,
        () => void handleOpenStorageRoot(),
      );
    }
  };

  // 默认存储基座含中文且未设置统一目录：常驻警示引导（design D6-3）
  const showDefaultCjkWarning = !storageRoot && containsCjk(userDataPath);

  // 切换启动时检查更新
  const handleCheckUpdateOnStartupChange = async (checked: boolean) => {
    setCheckUpdateOnStartup(checked);
    try {
      if (
        !(await persistence.persist({
          checkUpdateOnStartup: checked,
        }))
      )
        return;
      toast.success(
        checked
          ? t('checkUpdateOnStartupEnabled')
          : t('checkUpdateOnStartupDisabled'),
      );
    } catch (error) {
      reportError(t('saveFailed'), error);
    }
  };

  const handlePreventSleepDuringTaskChange = async (checked: boolean) => {
    setPreventSleepDuringTask(checked);
    try {
      if (
        !(await persistence.persist({
          preventSleepDuringTask: checked,
        }))
      )
        return;
      toast.success(
        checked
          ? t('preventSleepDuringTaskEnabled')
          : t('preventSleepDuringTaskDisabled'),
      );
    } catch (error) {
      reportError(t('saveFailed'), error);
    }
  };

  // 添加清除缓存函数
  const handleClearCache = async () => {
    setOperationError(null);
    try {
      const result = await window?.ipc?.invoke('clearCache');
      if (result) {
        toast.success(t('cacheClearedSuccess'));
      } else {
        reportError(
          t('cacheClearedFailed'),
          result,
          () => void handleClearCache(),
        );
      }
    } catch (error) {
      reportError(
        t('cacheClearedFailed'),
        error,
        () => void handleClearCache(),
      );
    }
  };

  const handleCloseActionChange = async (
    value: 'smart' | 'background' | 'quit',
  ) => {
    setCloseAction(value);
    try {
      if (!(await persistence.persist({ closeAction: value }))) return;
      toast.success(t('closeActionSaved'));
    } catch (error) {
      reportError(t('saveFailed'), error);
    }
  };

  // VAD 数字输入降噪：本地即时生效，500ms 静默期后批量持久化；成功静默，失败才打扰
  const handleVADSettingChange = (setting: string, raw: number | string) => {
    const value = raw === '' ? '' : Number(raw);
    const settingMap = {
      vadThreshold: setVADThreshold,
      vadMinSpeechDuration: setVADMinSpeechDuration,
      vadMinSilenceDuration: setVADMinSilenceDuration,
      vadMaxSpeechDuration: setVADMaxSpeechDuration,
      vadSpeechPad: setVADSpeechPad,
      vadSamplesOverlap: setVADSamplesOverlap,
    };

    settingMap[setting]?.(value);

    persistence.stage({ [setting]: value });
  };
  const invalidVadKeys = invalidVadSettings({
    vadThreshold,
    vadMinSpeechDuration,
    vadMinSilenceDuration,
    vadMaxSpeechDuration,
    vadSpeechPad,
    vadSamplesOverlap,
  });

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
      if (!(await persistence.persist(patch))) return;
      toast.success(t('proxySaved'));
    } catch {
      reportError(t('saveFailed'));
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
    setOperationError(null);
    setProxyTesting(true);
    try {
      // 先持久化当前输入，确保测试用的是最新代理
      if (
        !(await persistence.persist({
          proxyMode,
          proxyUrl,
          proxyNoProxy,
        }))
      )
        return;
      const result = await window?.ipc?.invoke('proxy:test');
      if (result?.ok) {
        toast.success(t('proxyTestOk', { ms: result.ms }));
      } else {
        reportError(
          t('proxyTestFail', { error: result?.error || 'unknown' }),
          result?.error,
          () => void handleProxyTest(),
        );
      }
    } catch (e) {
      reportError(
        t('proxyTestFail', { error: e instanceof Error ? e.message : 'error' }),
        e,
        () => void handleProxyTest(),
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
    persistence.stage(
      {
        downloadEndpoints: normalizeDownloadEndpoints({
          ...downloadEndpoints,
          [key]: value,
        }),
      },
      null,
    );
  };

  const persistDownloadEndpoints = async (next: DownloadEndpointConfig) => {
    const normalized = normalizeDownloadEndpoints(next);
    setDownloadEndpoints(normalized);
    const overrides: Partial<DownloadEndpointConfig> = {};
    EDITABLE_DOWNLOAD_ENDPOINT_KEYS.forEach((key) => {
      overrides[key] = normalized[key];
    });
    try {
      if (
        !(await persistence.persist({
          downloadEndpoints: overrides,
        }))
      )
        return;
      invalidateDownloadEndpointsCache();
      toast.success(t('downloadEndpointsSaved'));
    } catch {
      reportError(t('saveFailed'));
    }
  };

  const handleEndpointBlur = () => {
    void persistDownloadEndpoints(downloadEndpoints);
  };

  const handleEndpointsReset = async () => {
    setDownloadEndpoints(DEFAULT_DOWNLOAD_ENDPOINTS);
    try {
      if (!(await persistence.persist({ downloadEndpoints: {} }))) return;
      invalidateDownloadEndpointsCache();
      toast.success(t('downloadEndpointsResetDone'));
    } catch {
      reportError(t('saveFailed'));
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
    if (isExporting) return;
    setOperationError(null);
    if (!exportPassword) {
      reportError(t('passwordRequired'));
      return;
    }
    if (exportPassword !== exportConfirmPassword) {
      reportError(t('passwordMismatch'));
      return;
    }
    setIsExporting(true);
    try {
      if (persistence.getIsDirty() && !(await persistence.save())) return;
      const result = await window?.ipc?.invoke('exportConfig', exportPassword);
      if (result?.success) {
        toast.success(t('exportSuccess'));
        setExportDialogOpen(false);
        setExportPassword('');
        setExportConfirmPassword('');
      } else if (result?.error === 'canceled') {
        toast.info(t('exportCanceled'));
      } else {
        reportError(t('exportFailed'), result?.error);
      }
    } catch (cause) {
      reportError(t('exportFailed'), cause);
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async () => {
    if (isImporting) return;
    setOperationError(null);
    if (!importPassword) {
      reportError(t('passwordRequired'));
      return;
    }
    setIsImporting(true);
    try {
      if (persistence.getIsDirty() && !(await persistence.save())) return;
      const result = await window?.ipc?.invoke('importConfig', importPassword);
      if (result?.success) {
        toast.success(t('importSuccess'));
        setImportDialogOpen(false);
        setImportPassword('');
        await persistence.load();
        await loadPaths();
      } else if (result?.error === 'canceled') {
        toast.info(t('importCanceled'));
      } else if (result?.error === 'invalidPassword') {
        reportError(t('invalidPassword'));
      } else if (result?.error === 'invalidConfigFile') {
        reportError(t('invalidConfigFile'));
      } else {
        reportError(t('importFailed'), result?.error);
      }
    } catch (cause) {
      reportError(t('importFailed'), cause);
    } finally {
      setIsImporting(false);
    }
  };

  const operationBanner = operationError && (
    <div role="alert" className="space-y-2 bg-destructive/10 p-3 text-sm">
      <p>{operationError.message}</p>
      <p className="text-muted-foreground">{t('persistence.repair')}</p>
      <details>
        <summary>{commonT('saveState.details')}</summary>
        <p className="break-all whitespace-pre-wrap">
          {operationError.details}
        </p>
      </details>
      {operationError.retry && (
        <Button size="sm" variant="outline" onClick={operationError.retry}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('persistence.retry')}
        </Button>
      )}
    </div>
  );
  if (!persistence.loaded)
    return (
      <div className="p-3">
        {persistence.loadError ? (
          <div role="alert" className="space-y-3 bg-destructive/10 p-4 text-sm">
            <p>{t('persistence.loadFailed')}</p>
            <p>{t('persistence.repair')}</p>
            <details>
              <summary>{commonT('saveState.details')}</summary>
              <p className="break-all">{persistence.loadError}</p>
            </details>
            <Button
              disabled={persistence.loading}
              onClick={() => void persistence.load()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('persistence.reload')}
            </Button>
          </div>
        ) : (
          <p role="status">{t('persistence.loading')}</p>
        )}
      </div>
    );

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-4xl space-y-2.5 p-3">
        <PageHeader title={t('settings')} description={t('settingsDesc')} />
        <div className="sticky top-0 z-20 space-y-2 bg-background py-2">
          <p role="status" className="text-xs text-muted-foreground">
            {commonT(
              `saveState.${persistence.saving ? 'saving' : persistence.error ? 'save_error' : persistence.isDirty ? 'dirty' : 'saved'}`,
            )}
          </p>
          {persistence.error && (
            <div
              role="alert"
              className="space-y-2 bg-destructive/10 p-3 text-sm"
            >
              <p>{t('saveFailed')}</p>
              <p>
                {t(
                  persistence.error.startsWith('INVALID_VAD_SETTINGS:')
                    ? 'persistence.invalidVad'
                    : 'persistence.repair',
                )}
              </p>
              <details>
                <summary>{commonT('saveState.details')}</summary>
                <p className="break-all whitespace-pre-wrap">
                  {persistence.error}
                </p>
              </details>
              <Button
                size="sm"
                variant="outline"
                disabled={persistence.saving}
                onClick={() => void persistence.save()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {commonT('saveState.retry')}
              </Button>
            </div>
          )}
          {pathsError && (
            <div
              role="alert"
              className="space-y-2 bg-destructive/10 p-3 text-sm"
            >
              <p>{t('persistence.pathsFailed')}</p>
              <details>
                <summary>{commonT('saveState.details')}</summary>
                <p className="break-all">{pathsError}</p>
              </details>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadPaths()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('persistence.reload')}
              </Button>
            </div>
          )}
          {!exportDialogOpen &&
            !importDialogOpen &&
            !storageMoveDialog &&
            operationBanner}
        </div>

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

            <CustomLanguageManager
              languages={customLanguages}
              onSave={(next) => {
                setCustomLanguages(next);
                return persistence.persist({ customLanguages: next });
              }}
              saveError={persistence.error}
              onRetry={persistence.save}
            />

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>{t('checkUpdateOnStartup')}</span>
                <HelpHint text={t('checkUpdateOnStartupTip')} />
              </div>
              <Switch
                aria-label={t('checkUpdateOnStartup')}
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
                aria-label={t('preventSleepDuringTask')}
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
                    aria-label={t('useCustomTempDir')}
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
                    aria-label={t('proxyUrl')}
                    onChange={(e) => {
                      setProxyUrl(e.target.value);
                      persistence.stage({ proxyUrl: e.target.value }, null);
                    }}
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
                    aria-label={t('proxyNoProxy')}
                    onChange={(e) => {
                      setProxyNoProxy(e.target.value);
                      persistence.stage({ proxyNoProxy: e.target.value }, null);
                    }}
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
                      aria-label={t(`downloadEndpointFields.${key}.label`)}
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
                {invalidVadKeys.length > 0 && (
                  <p role="alert" className="text-sm text-destructive">
                    {t('persistence.invalidVad')}
                  </p>
                )}

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
                    aria-label={t('vadThreshold')}
                    aria-invalid={invalidVadKeys.includes('vadThreshold')}
                    type="number"
                    step="0.1"
                    min="0"
                    max="1"
                    value={vadThreshold}
                    onChange={(e) =>
                      handleVADSettingChange('vadThreshold', e.target.value)
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
                    aria-label={t('vadMinSpeechDuration')}
                    aria-invalid={invalidVadKeys.includes(
                      'vadMinSpeechDuration',
                    )}
                    type="number"
                    min="0"
                    value={vadMinSpeechDuration}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadMinSpeechDuration',
                        e.target.value,
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
                    aria-label={t('vadMinSilenceDuration')}
                    aria-invalid={invalidVadKeys.includes(
                      'vadMinSilenceDuration',
                    )}
                    type="number"
                    min="0"
                    value={vadMinSilenceDuration}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadMinSilenceDuration',
                        e.target.value,
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
                    aria-label={t('vadMaxSpeechDuration')}
                    aria-invalid={invalidVadKeys.includes(
                      'vadMaxSpeechDuration',
                    )}
                    type="number"
                    min="0"
                    value={vadMaxSpeechDuration}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadMaxSpeechDuration',
                        e.target.value,
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
                    aria-label={t('vadSpeechPad')}
                    aria-invalid={invalidVadKeys.includes('vadSpeechPad')}
                    type="number"
                    min="0"
                    value={vadSpeechPad}
                    onChange={(e) =>
                      handleVADSettingChange('vadSpeechPad', e.target.value)
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
                    aria-label={t('vadSamplesOverlap')}
                    aria-invalid={invalidVadKeys.includes('vadSamplesOverlap')}
                    type="number"
                    step="0.1"
                    min="0"
                    max="1"
                    value={vadSamplesOverlap}
                    onChange={(e) =>
                      handleVADSettingChange(
                        'vadSamplesOverlap',
                        e.target.value,
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
                onClick={() => {
                  setOperationError(null);
                  setExportDialogOpen(true);
                }}
                className="flex items-center gap-1.5"
              >
                <Upload className="h-4 w-4" />
                {t('exportConfig')}
              </Button>
              <Button
                onClick={() => {
                  setOperationError(null);
                  setImportDialogOpen(true);
                }}
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
            {operationBanner}
            {persistence.error && (
              <p role="alert" className="text-destructive">
                {t('saveFailed')}
              </p>
            )}
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
            {operationBanner}
            {persistence.error && (
              <p role="alert" className="text-destructive">
                {t('saveFailed')}
              </p>
            )}
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
            {operationBanner}
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
