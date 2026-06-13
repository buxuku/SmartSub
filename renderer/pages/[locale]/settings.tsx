import React, { useEffect, useRef, useState, SetStateAction } from 'react';
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
  Globe,
  Trash2,
  Cog,
  ChevronDown,
  HelpCircle,
  Eraser,
  Activity,
  Download,
  Upload,
  Wrench,
  Info,
  RefreshCw,
  Github,
  MessageSquareWarning,
  ScrollText,
  Save,
  ArrowRight,
  FolderOpen,
  SlidersHorizontal,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
import { openUrl } from 'lib/utils';
import packageInfo from '../../../package.json';

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
      vadSpeechPad: 50,
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
      vadSpeechPad: 30,
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
      vadSpeechPad: 50,
      vadSamplesOverlap: 0.1,
    },
  },
];
const STANDARD_PRESET = VAD_PRESETS[1];

// 新增一个 CommandInput 组件
const CommandInput = ({
  label,
  tooltip,
  value = '',
  onChange,
  onSave,
}: {
  label: string;
  tooltip: string;
  value: string;
  onChange: (value: SetStateAction<string>) => void;
  onSave: () => void;
}) => {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span>{label}</span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger>
              <HelpCircle className="h-4 w-4 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent>
              <p>{tooltip}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex gap-2">
        <Input
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-sm"
          placeholder={t('whisperCommandPlaceholder')}
        />
        <Button onClick={onSave} size="sm" className="flex-shrink-0 gap-1.5">
          <Save className="h-4 w-4" />
          {t('save')}
        </Button>
      </div>
    </div>
  );
};

const Settings = () => {
  const router = useRouter();
  const { t, i18n } = useTranslation('settings');
  const [currentLanguage, setCurrentLanguage] = useState(router.locale);
  const [useLocalWhisper, setUseLocalWhisper] = useState(false);
  const [whisperCommand, setWhisperCommand] = useState('');
  const [tempDir, setTempDir] = useState('');
  const [customTempDir, setCustomTempDir] = useState('');
  const [useCustomTempDir, setUseCustomTempDir] = useState(false);
  const [checkUpdateOnStartup, setCheckUpdateOnStartup] = useState(true);
  const [useVAD, setUseVAD] = useState(true);
  const [vadThreshold, setVADThreshold] = useState(0.5);
  const [vadMinSpeechDuration, setVADMinSpeechDuration] = useState(250);
  const [vadMinSilenceDuration, setVADMinSilenceDuration] = useState(100);
  const [vadMaxSpeechDuration, setVADMaxSpeechDuration] = useState(0);
  const [vadSpeechPad, setVADSpeechPad] = useState(30);
  const [vadSamplesOverlap, setVADSamplesOverlap] = useState(0.1);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
        setUseLocalWhisper(settings.useLocalWhisper || false);
        setWhisperCommand(settings.whisperCommand || '');
        setUseCustomTempDir(settings.useCustomTempDir || false);
        setCustomTempDir(settings.customTempDir || '');
        setCheckUpdateOnStartup(settings.checkUpdateOnStartup !== false);
        setUseVAD(settings.useVAD !== false);
        setVADThreshold(settings.vadThreshold ?? 0.5);
        setVADMinSpeechDuration(settings.vadMinSpeechDuration ?? 250);
        setVADMinSilenceDuration(settings.vadMinSilenceDuration ?? 100);
        setVADMaxSpeechDuration(settings.vadMaxSpeechDuration ?? 0);
        setVADSpeechPad(settings.vadSpeechPad ?? 30);
        setVADSamplesOverlap(settings.vadSamplesOverlap ?? 0.1);
      }

      // 获取临时目录路径
      const tempDirPath = await window?.ipc?.invoke('getTempDir');
      setTempDir(tempDirPath || '');
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

  const handleLocalWhisperChange = async (checked: boolean) => {
    await window?.ipc?.invoke('setSettings', {
      useLocalWhisper: checked,
      whisperCommand: whisperCommand,
    });
    setUseLocalWhisper(checked);
  };

  // 选择自定义临时目录
  const handleSelectCustomTempDir = async () => {
    const result = await window?.ipc?.invoke('selectDirectory');
    if (result.canceled) return;

    const selectedPath = result.directoryPath;
    setCustomTempDir(selectedPath);

    try {
      await window?.ipc?.invoke('setSettings', {
        customTempDir: selectedPath,
        useCustomTempDir: true,
      });
      setUseCustomTempDir(true);
      toast.success(t('tempDirSaved'));
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
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

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

  // 统一的设置保存函数
  const saveSettings = async (settings: Partial<any>) => {
    try {
      await window?.ipc?.invoke('setSettings', settings);
      toast.success(t('commandSaved'));
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  const handleWhisperCommandSave = () => {
    saveSettings({
      useLocalWhisper,
      whisperCommand,
    });
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

  const handleVADChange = async (checked: boolean) => {
    setUseVAD(checked);
    try {
      await window?.ipc?.invoke('setSettings', { useVAD: checked });
      toast.success(t('vadSettingsSaved'));
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
    <div className="container mx-auto p-4 space-y-6">
      <PageHeader title={t('settings')} description={t('settingsDesc')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Globe className="mr-2" />
            {t('languageSettings')}
          </CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Cog className="mr-2" />
            {t('systemSettings')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>{t('checkUpdateOnStartup')}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('checkUpdateOnStartupTip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Switch
              checked={checkUpdateOnStartup}
              onCheckedChange={handleCheckUpdateOnStartupChange}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>{t('modelsPath')}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('modelsPathMoved')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() =>
                router.push(`/${i18n.language}/resources?tab=models`)
              }
            >
              <ArrowRight className="h-4 w-4" />
              {t('goToResources')}
            </Button>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>{t('gpuAccelerationTitle')}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('gpuAccelerationMoved')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() =>
                router.push(`/${i18n.language}/resources?tab=acceleration`)
              }
            >
              <ArrowRight className="h-4 w-4" />
              {t('goToResources')}
            </Button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span>{t('tempDir')}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('tempDirTip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
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
                    className="flex-shrink-0"
                  >
                    <Eraser className="mr-2 h-4 w-4" />
                    {t('clearCache')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer select-none">
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center">
                  <Wrench className="mr-2" />
                  {t('advancedSettings')}
                </span>
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground transition-transform ${
                    advancedOpen ? 'rotate-180' : ''
                  }`}
                />
              </CardTitle>
              <p className="text-sm text-muted-foreground pt-1">
                {t('advancedSettingsDesc')}
              </p>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span>{t('useLocalWhisper')}</span>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <HelpCircle className="h-4 w-4 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('useLocalWhisperTip')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Switch
                  checked={useLocalWhisper}
                  onCheckedChange={handleLocalWhisperChange}
                />
              </div>

              {useLocalWhisper && (
                <CommandInput
                  label={t('whisperCommand')}
                  tooltip={t('whisperCommandTip')}
                  value={whisperCommand}
                  onChange={setWhisperCommand}
                  onSave={handleWhisperCommandSave}
                />
              )}

              <div className="flex items-center gap-2 pt-2 border-t">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t('vadSettings')}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span>{t('enableVad')}</span>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <HelpCircle className="h-4 w-4 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('enableVadTip')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Switch checked={useVAD} onCheckedChange={handleVADChange} />
              </div>

              {useVAD && (
                <>
                  {/* 三档环境预设：与手动微调共存，当前值与某档全等时高亮 */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {t('vadPresets')}
                    </span>
                    {VAD_PRESETS.map((preset) => (
                      <Button
                        key={preset.id}
                        variant={
                          isPresetActive(preset) ? 'secondary' : 'outline'
                        }
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
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('vadThresholdTip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('vadMinSpeechDurationTip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('vadMinSilenceDurationTip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('vadMaxSpeechDurationTip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('vadSpeechPadTip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('vadSamplesOverlapTip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                </>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Download className="mr-2" />
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
              className="flex items-center"
            >
              <Upload className="mr-2 h-4 w-4" />
              {t('exportConfig')}
            </Button>
            <Button
              onClick={() => setImportDialogOpen(true)}
              variant="outline"
              className="flex items-center"
            >
              <Download className="mr-2 h-4 w-4" />
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Info className="mr-2" />
            {t('about')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">{t('common:headerTitle')}</div>
              <div className="text-sm text-muted-foreground">
                v{packageInfo.version}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('app-check-updates'))
              }
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('common:help.checkUpdates')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => openUrl('https://github.com/buxuku/SmartSub')}
            >
              <Github className="mr-2 h-4 w-4" />
              {t('common:help.github')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() =>
                openUrl('https://github.com/buxuku/SmartSub/issues')
              }
            >
              <MessageSquareWarning className="mr-2 h-4 w-4" />
              {t('common:help.reportIssue')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('app-open-logs'))
              }
            >
              <ScrollText className="mr-2 h-4 w-4" />
              {t('common:viewLogs')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="flex items-center text-destructive">
            <Trash2 className="mr-2" />
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
                  className="flex items-center text-destructive hover:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
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
  );
};

export default Settings;

export const getStaticProps = makeStaticProperties([
  'common',
  'settings',
  'parameters',
]);

export { getStaticPaths };
