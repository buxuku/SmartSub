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
import { Globe, Trash2, Cog, HelpCircle, Eraser } from 'lucide-react';
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
            <Switch
              checked={useCuda}
              onCheckedChange={handleCudaChange}
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
              <Button onClick={handleSelectModelsPath} size="sm" className="flex-shrink-0">
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
            <div className="flex gap-2">
              <Input
                value={tempDir}
                readOnly
                className="font-mono text-sm flex-1"
                placeholder={t('tempDirPlaceholder')}
              />
              <Button onClick={handleClearCache} size="sm" className="flex-shrink-0">
                <Eraser className="mr-2 h-4 w-4" />
                {t('clearCache')}
              </Button>
            </div>
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

export const getStaticProps = makeStaticProperties(['common', 'settings']);

export { getStaticPaths };
