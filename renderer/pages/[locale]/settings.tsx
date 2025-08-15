import React, { useEffect, useState, SetStateAction } from 'react';
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
import { Globe, Trash2, Cog, HelpCircle, Eraser, Activity } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';

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
        <Button onClick={onSave} size="sm" className="flex-shrink-0">
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
  const [useCuda, setUseCuda] = useState(false);
  const [modelsPath, setModelsPath] = useState('');
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
        setUseCuda(settings.useCuda || false);
        setModelsPath(settings.modelsPath || '');
        setUseCustomTempDir(settings.useCustomTempDir || false);
        setCustomTempDir(settings.customTempDir || '');
        setCheckUpdateOnStartup(settings.checkUpdateOnStartup !== false);
        setUseVAD(settings.useVAD !== false);
        setVADThreshold(settings.vadThreshold || 0.5);
        setVADMinSpeechDuration(settings.vadMinSpeechDuration || 250);
        setVADMinSilenceDuration(settings.vadMinSilenceDuration || 100);
        setVADMaxSpeechDuration(settings.vadMaxSpeechDuration || 0);
        setVADSpeechPad(settings.vadSpeechPad || 30);
        setVADSamplesOverlap(settings.vadSamplesOverlap || 0.1);
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

  const handleCudaChange = async (checked: boolean) => {
    await window?.ipc?.invoke('setSettings', {
      useCuda: checked,
    });
    setUseCuda(checked);
  };

  const handleSelectModelsPath = async () => {
    const result = await window?.ipc?.invoke('selectDirectory');
    if (result.canceled) return;

    const selectedPath = result.filePaths[0];
    setModelsPath(selectedPath);

    try {
      await window?.ipc?.invoke('setSettings', { modelsPath: selectedPath });
      toast.success(t('modelPathSaved'));
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  // 选择自定义临时目录
  const handleSelectCustomTempDir = async () => {
    const result = await window?.ipc?.invoke('selectDirectory');
    if (result.canceled) return;

    const selectedPath = result.filePaths[0];
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

  const handleVADSettingChange = async (setting: string, value: number) => {
    const settingMap = {
      vadThreshold: setVADThreshold,
      vadMinSpeechDuration: setVADMinSpeechDuration,
      vadMinSilenceDuration: setVADMinSilenceDuration,
      vadMaxSpeechDuration: setVADMaxSpeechDuration,
      vadSpeechPad: setVADSpeechPad,
      vadSamplesOverlap: setVADSamplesOverlap,
    };

    settingMap[setting]?.(value);

    try {
      await window?.ipc?.invoke('setSettings', { [setting]: value });
      toast.success(t('vadSettingsSaved'));
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  return (
    <div className="container mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold mb-6">{t('settings')}</h1>

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

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>{t('useCuda')}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('useCudaTip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Switch checked={useCuda} onCheckedChange={handleCudaChange} />
          </div>

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

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span>{t('modelsPath')}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('modelsPathTip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="flex gap-2">
              <Input
                value={modelsPath}
                readOnly
                className="font-mono text-sm flex-1"
                placeholder={t('modelsPathPlaceholder')}
              />
              <Button
                onClick={handleSelectModelsPath}
                size="sm"
                className="flex-shrink-0"
              >
                {t('selectPath')}
              </Button>
            </div>
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
                    className="flex-shrink-0"
                  >
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
        <CardHeader>
          <CardTitle className="flex items-center">
            <Activity className="mr-2" />
            {t('vadSettings')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <Button
              onClick={handleClearConfig}
              variant="destructive"
              className="flex items-center"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t('restore')}
            </Button>
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
