import React, { useEffect, useState } from 'react';
import {
  SelectValue,
  SelectTrigger,
  SelectItem,
  SelectContent,
  Select,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { models as whisperModels, supportedLanguage } from 'lib/utils';
import Models from './Models';
import SavePathNotice from './SavePathNotice';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form';
import { useTranslation } from 'next-i18next';
import ToolTips from './ToolTips';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import { Card } from './ui/card';
import { cn } from 'lib/utils';
import {
  apiTranscriptionModels,
  DEFAULT_TRANSCRIPTION_PROVIDER,
  reazonSpeechModels,
  transcriptionProviders,
  type TranscriptionProviderId,
} from '../../types';

// 定义 Provider 类型
type Provider = {
  id: string;
  name: string;
  type: 'api' | 'local' | 'openai';
};

// 任务类型枚举
type TaskType = 'generateAndTranslate' | 'generateOnly' | 'translateOnly';

type ModelOption = {
  value: string;
  label: string;
};

export function getTranscriptionModelOptions(
  provider: TranscriptionProviderId,
  modelsInstalled: string[] = [],
  _useLocalWhisper = false,
): ModelOption[] {
  if (provider === 'openrouter') {
    return apiTranscriptionModels.map((model) => ({
      value: model.id,
      label: model.name,
    }));
  }

  if (provider === 'reazonspeech-k2') {
    const installed = new Set(
      modelsInstalled.map((model) => model.toLowerCase()),
    );
    return reazonSpeechModels
      .filter((model) => installed.has(model.id.toLowerCase()))
      .map((model) => ({
        value: model.id,
        label: model.name,
      }));
  }

  if (provider === 'local-whisper-command') {
    return whisperModels.map((model) => ({
      value: model.name.toLowerCase(),
      label: model.name,
    }));
  }

  const reazonIds = new Set(
    reazonSpeechModels.map((model) => model.id.toLowerCase()),
  );
  return modelsInstalled
    .filter((model) => !reazonIds.has(model.toLowerCase()))
    .map((model) => ({
      value: model.toLowerCase(),
      label: model,
    }));
}

const TaskConfigForm = ({ form, formData, systemInfo }) => {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [useLocalWhisper, setUseLocalWhisper] = useState(false);
  const { taskType, sourceSrtSaveOption } = formData;
  const activeTranscriptionProvider = (formData.transcriptionProvider ||
    (useLocalWhisper
      ? 'local-whisper-command'
      : DEFAULT_TRANSCRIPTION_PROVIDER)) as TranscriptionProviderId;
  const [taskTab, setTaskTab] = useState<string>('sourceSubtitle');
  const { t } = useTranslation('home');
  const { t: tCommon } = useTranslation('common');

  useEffect(() => {
    loadProviders();
    loadSettings();
  }, []);

  const loadProviders = async () => {
    const storedProviders = await window.ipc.invoke('getTranslationProviders');
    setProviders(storedProviders);
  };

  const loadSettings = async () => {
    const settings = await window?.ipc?.invoke('getSettings');
    if (settings) {
      setUseLocalWhisper(settings.useLocalWhisper || false);
      if (!form.getValues('transcriptionProvider')) {
        form.setValue(
          'transcriptionProvider',
          settings.useLocalWhisper
            ? 'local-whisper-command'
            : DEFAULT_TRANSCRIPTION_PROVIDER,
        );
      }
    }
  };

  const pickModelForProvider = (provider: TranscriptionProviderId) => {
    const options = getTranscriptionModelOptions(
      provider,
      systemInfo.modelsInstalled || [],
      useLocalWhisper,
    );
    const currentModel = form.getValues('model');
    const currentAvailable = options.some(
      (option) => option.value === currentModel,
    );
    return currentAvailable ? currentModel : options[0]?.value || '';
  };

  // 是否需要显示源字幕设置
  const showSourceSubtitleSettings =
    taskType === 'generateAndTranslate' || taskType === 'generateOnly';

  // 是否需要显示翻译设置
  const showTranslationSettings =
    taskType === 'generateAndTranslate' || taskType === 'translateOnly';

  // 当任务类型变更时，更新表单相关字段
  useEffect(() => {
    if (taskType === 'translateOnly') {
      setTaskTab('translation');
      form.setValue('targetSrtSaveOption', 'fileNameWithLang');
    } else if (taskType === 'generateOnly') {
      setTaskTab('sourceSubtitle');
      form.setValue('sourceSrtSaveOption', 'fileName');
    } else {
      setTaskTab('sourceSubtitle');
    }
  }, [taskType, form]);

  if (!providers.length || !systemInfo.modelsPath) return null;

  return (
    <Form {...form}>
      <form className="grid w-full items-start gap-4">
        {/* 任务类型选择 */}
        <fieldset className="grid gap-3 rounded-lg border p-3">
          <legend className="-ml-1 px-1 text-sm font-medium">
            {t('taskTypeSelection')}
          </legend>
          <div className="grid gap-2">
            <FormField
              control={form.control}
              name="taskType"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <TaskTypeCard
                        title={t('generateAndTranslate')}
                        description={t('generateAndTranslateDesc')}
                        value="generateAndTranslate"
                        selected={field.value === 'generateAndTranslate'}
                        onClick={() => field.onChange('generateAndTranslate')}
                      />
                      <TaskTypeCard
                        title={t('generateOnly')}
                        description={t('generateOnlyDesc')}
                        value="generateOnly"
                        selected={field.value === 'generateOnly'}
                        onClick={() => field.onChange('generateOnly')}
                      />
                      <TaskTypeCard
                        title={t('translateOnly')}
                        description={t('translateOnlyDesc')}
                        value="translateOnly"
                        selected={field.value === 'translateOnly'}
                        onClick={() => field.onChange('translateOnly')}
                      />
                    </div>
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </fieldset>

        {/* 配置选项 Tabs */}
        <Tabs
          value={taskTab}
          onValueChange={(value) => setTaskTab(value)}
          className="w-full"
        >
          <TabsList className="w-full justify-start">
            {showSourceSubtitleSettings && (
              <TabsTrigger value="sourceSubtitle">
                {t('sourceSubtitleSettings')}
              </TabsTrigger>
            )}
            {showTranslationSettings && (
              <TabsTrigger value="translation">
                {t('translationSettings')}
              </TabsTrigger>
            )}
            <TabsTrigger value="advanced">{t('advancedSettings')}</TabsTrigger>
          </TabsList>

          {/* 源字幕设置 Tab */}
          {showSourceSubtitleSettings && (
            <TabsContent value="sourceSubtitle" className="mt-3">
              <fieldset className="grid gap-3 rounded-lg border p-3">
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="transcriptionProvider"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('transcriptionProvider')}</FormLabel>
                        <Select
                          onValueChange={(value) => {
                            const provider = value as TranscriptionProviderId;
                            field.onChange(provider);
                            form.setValue(
                              'model',
                              pickModelForProvider(provider),
                            );
                          }}
                          value={field.value || activeTranscriptionProvider}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {transcriptionProviders.map((provider) => (
                              <SelectItem key={provider.id} value={provider.id}>
                                {t(`transcriptionProviders.${provider.id}`, {
                                  defaultValue: provider.name,
                                })}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormDescription className="text-xs">
                          {t(
                            `transcriptionProviderDesc.${activeTranscriptionProvider}`,
                            {
                              defaultValue: '',
                            },
                          )}
                        </FormDescription>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('modelSelection')}</FormLabel>
                        <FormControl>
                          <Models
                            onValueChange={field.onChange}
                            value={field.value}
                            modelsInstalled={systemInfo.modelsInstalled}
                            useLocalWhisper={useLocalWhisper}
                            transcriptionProvider={activeTranscriptionProvider}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="sourceLanguage"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('originalLanguage')}</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value={'auto'}>
                              {t('autoRecognition')}
                            </SelectItem>
                            {supportedLanguage.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {tCommon(`language.${item.value}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="prompt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center">
                          {t('prompt')} <ToolTips text={t('promptTips')} />
                        </FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder={t('pleaseInput')}
                            {...field}
                            value={field.value || ''}
                            className="min-h-[60px]"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="maxContext"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center">
                          {t('maxContext')}
                          <ToolTips text={t('maxContextTip')} />
                        </FormLabel>
                        <Select
                          onValueChange={(value) =>
                            field.onChange(Number(value))
                          }
                          value={String(field.value ?? -1)}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="-1">{t('noLimit')}</SelectItem>
                            <SelectItem value="0">{t('noContext')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="sourceSrtSaveOption"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center">
                          {t('sourceSubtitleSaveSettings')}
                          <SavePathNotice />
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value || 'fileName'}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {taskType !== 'generateOnly' && (
                              <SelectItem value="noSave">
                                {t('noSave')}
                              </SelectItem>
                            )}
                            <SelectItem value="fileName">
                              {t('fileName')}
                            </SelectItem>
                            <SelectItem value="fileNameWithLang">
                              {t('fileNameWithLang')}
                            </SelectItem>
                            <SelectItem value="custom">
                              {t('customSettings')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                  {formData.sourceSrtSaveOption === 'custom' && (
                    <FormField
                      control={form.control}
                      name="customSourceSrtFileName"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              placeholder={t(
                                'pleaseInputCustomSourceSrtFileName',
                              )}
                              {...field}
                              value={
                                field.value || '${fileName}.${sourceLanguage}'
                              }
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  )}
                </div>
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="saveAudio"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-2 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel>{t('saveAudio')}</FormLabel>
                          <FormDescription className="text-xs">
                            {t('saveAudioTip')}
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            aria-readonly
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
              </fieldset>
            </TabsContent>
          )}

          {/* 翻译设置 Tab */}
          {showTranslationSettings && (
            <TabsContent value="translation" className="mt-3">
              <fieldset className="grid gap-3 rounded-lg border p-3">
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="translateProvider"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('translationService')}</FormLabel>
                        <Select
                          onValueChange={(value) => {
                            field.onChange(value);
                          }}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {providers.map((provider) => (
                              <SelectItem key={provider.id} value={provider.id}>
                                {tCommon(`provider.${provider.name}`, {
                                  defaultValue: provider.name,
                                })}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                </div>
                {taskType === 'translateOnly' && (
                  <div className="grid gap-2">
                    <FormField
                      control={form.control}
                      name="sourceLanguage"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('originalLanguage')}</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            value={field.value}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder={t('pleaseSelect')} />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value={'auto'}>
                                {t('autoRecognition')}
                              </SelectItem>
                              {supportedLanguage.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                  {tCommon(`language.${item.value}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </div>
                )}
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="targetLanguage"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('translationTargetLanguage')}</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {supportedLanguage.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {tCommon(`language.${item.value}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="translateContent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {t('translationOutputSubtitleSettings')}
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="onlyTranslate">
                              {t('onlyOutputTranslationSubtitle')}
                            </SelectItem>
                            <SelectItem value="sourceAndTranslate">
                              {t('sourceAndTranslate')}
                            </SelectItem>
                            <SelectItem value="translateAndSource">
                              {t('translateAndSource')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-2">
                  <FormField
                    control={form.control}
                    name="targetSrtSaveOption"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center">
                          {t('translationSubtitleSaveSettings')}
                          <SavePathNotice />
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value || 'fileNameWithLang'}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {taskType === 'generateAndTranslate' && (
                              <SelectItem value="fileName">
                                {t('fileName')}
                              </SelectItem>
                            )}
                            <SelectItem value="fileNameWithLang">
                              {t('fileNameWithLang')}
                            </SelectItem>
                            <SelectItem value="custom">
                              {t('customSettings')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                  {formData.targetSrtSaveOption === 'custom' && (
                    <FormField
                      control={form.control}
                      name="customTargetSrtFileName"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              placeholder={t(
                                'pleaseInputCustomTargetSrtFileName',
                              )}
                              {...field}
                              value={
                                field.value || '${fileName}.${targetLanguage}'
                              }
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  )}
                  <FormField
                    control={form.control}
                    name="translateRetryTimes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('translateRetryTimes')}</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            placeholder={t('pleaseInput')}
                            {...field}
                            value={field.value || 0}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
              </fieldset>
            </TabsContent>
          )}

          {/* 高级设置 Tab */}
          <TabsContent value="advanced" className="mt-3">
            <fieldset className="grid gap-3 rounded-lg border p-3">
              <FormField
                control={form.control}
                name="maxConcurrentTasks"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('maxConcurrentTasks')}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder={t('pleaseInputMaxConcurrentTasks')}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                        min={1}
                        value={field.value || 1}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </fieldset>
          </TabsContent>
        </Tabs>
      </form>
    </Form>
  );
};

// 任务类型卡片组件
const TaskTypeCard = ({ title, description, value, selected, onClick }) => {
  return (
    <Card
      className={cn(
        'p-2 cursor-pointer transition-all hover:shadow-md border-1',
        selected ? 'bg-primary/5' : 'border-transparent',
      )}
      onClick={onClick}
    >
      <div className="font-medium text-sm mb-1">{title}</div>
      <p className="text-xs text-muted-foreground leading-tight">
        {description}
      </p>
    </Card>
  );
};

export default TaskConfigForm;
