import React, { useEffect, useState } from 'react';
import {
  SelectValue,
  SelectTrigger,
  SelectItem,
  SelectContent,
  Select,
} from '@/components/ui/select';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { supportedLanguage } from 'lib/utils';
import Models from './Models';
import SavePathNotice from './SavePathNotice';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form';
import { useTranslation } from 'next-i18next';
import ToolTips from './ToolTips';

// 定义 Provider 类型
type Provider = {
  id: string;
  name: string;
  type: 'api' | 'local' | 'openai';
};

// 任务类型枚举
type TaskType = 'generateAndTranslate' | 'generateOnly' | 'translateOnly';

const TaskConfigForm = ({ form, formData, systemInfo }) => {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [taskType, setTaskType] = useState<TaskType>('generateAndTranslate');
  const [taskTab, setTaskTab] = useState<string>('sourceSubtitle');
  const { t } = useTranslation('home');
  const { t: tCommon } = useTranslation('common');

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    const storedProviders = await window.ipc.invoke('getTranslationProviders');
    setProviders(storedProviders);
  };

  // 是否需要显示源字幕设置
  const showSourceSubtitleSettings = taskType === 'generateAndTranslate' || taskType === 'generateOnly';
  
  // 是否需要显示翻译设置
  const showTranslationSettings = taskType === 'generateAndTranslate' || taskType === 'translateOnly';

  // 当任务类型变更时，更新表单相关字段
  useEffect(() => {
    if (taskType === 'translateOnly') {
      // 如果只是翻译，设置不保存源字幕
      form.setValue('sourceSrtSaveOption', 'noSave');
      setTaskTab('translation');
    } else if (taskType === 'generateOnly') {
      // 如果只是生成字幕，设置不翻译
      form.setValue('translateProvider', '-1');
      setTaskTab('sourceSubtitle');
    } else {
      setTaskTab('sourceSubtitle');
    }
    
    // 通知父组件任务类型发生变化
    if (form.setValue) {
      form.setValue('taskType', taskType);
    }
  }, [taskType, form]);

  if (!providers.length || !systemInfo.modelsPath) return null;
  
  return (
    <Form {...form}>
      <form className="grid w-full items-start gap-6">
        {/* 任务类型选择 */}
        <fieldset className="grid gap-4 rounded-lg border p-4">
          <legend className="-ml-1 px-1 text-sm font-medium">
            {t('taskTypeSelection')}
          </legend>
          <div className="grid gap-3">
            <FormField
              control={form.control}
              name="taskType"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between space-x-4">
                  <FormLabel className="flex-shrink-0 mt-2">{t('taskType')}</FormLabel>
                  <FormControl>
                    <Select 
                      onValueChange={(value: TaskType) => {
                        setTaskType(value);
                        field.onChange(value);
                      }}
                      value={field.value || taskType}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('pleaseSelect')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="generateAndTranslate">
                          {t('generateAndTranslate')}
                        </SelectItem>
                        <SelectItem value="generateOnly">
                          {t('generateOnly')}
                        </SelectItem>
                        <SelectItem value="translateOnly">
                          {t('translateOnly')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </fieldset>

        {/* 配置选项 Tabs */}
        <Tabs value={taskTab} onValueChange={(value) => setTaskTab(value)} className="w-full">
          <TabsList className="w-full justify-start">
            {showSourceSubtitleSettings && (
              <TabsTrigger value="sourceSubtitle">{t('sourceSubtitleSettings')}</TabsTrigger>
            )}
            {showTranslationSettings && (
              <TabsTrigger value="translation">{t('translationSettings')}</TabsTrigger>
            )}
            <TabsTrigger value="advanced">{t('advancedSettings')}</TabsTrigger>
          </TabsList>

          {/* 源字幕设置 Tab */}
          {showSourceSubtitleSettings && (
            <TabsContent value="sourceSubtitle" className="mt-4">
              <fieldset className="grid gap-4 rounded-lg border p-4">
                <div className="grid gap-3">
                  <FormField
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between space-x-4">
                        <FormLabel className="flex-shrink-0 mt-2">{t('modelSelection')}</FormLabel>
                        <FormControl>
                          <Models
                            onValueChange={field.onChange}
                            value={field.value}
                            modelsInstalled={systemInfo.modelsInstalled}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-3">
                  <FormField
                    control={form.control}
                    name="sourceLanguage"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between space-x-4">
                        <FormLabel className="flex-shrink-0 mt-2">{t('originalLanguage')}</FormLabel>
                        <FormControl>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
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
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-3">
                  <FormField
                    control={form.control}
                    name="maxContext"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between space-x-4">
                        <FormLabel className="flex-shrink-0 mt-2">
                          {t('maxContext')}
                          <ToolTips text={t('maxContextTip')} />
                        </FormLabel>
                        <FormControl>
                          <Select
                            onValueChange={(value) => field.onChange(Number(value))}
                            value={String(field.value || -1)}
                          >
                            <SelectTrigger className="w-[180px]">
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="-1">{t('noLimit')}</SelectItem>
                              <SelectItem value="0">{t('noContext')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-3">
                  <FormField
                    control={form.control}
                    name="prompt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center">{t('prompt')} <ToolTips text={t('promptTips')} /></FormLabel>
                        <FormControl>
                          <Input
                            placeholder={t('pleaseInput')}
                            {...field}
                            value={field.value || ''}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-3">
                  <FormField
                    control={form.control}
                    name="sourceSrtSaveOption"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center">
                          {t('sourceSubtitleSaveSettings')}
                          <SavePathNotice />
                        </FormLabel>
                        <FormControl>
                          <Select
                            onValueChange={field.onChange}
                            value={field.value || 'noSave'}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="noSave">{t('noSave')}</SelectItem>
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
                        </FormControl>
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
                              placeholder={t('pleaseInputCustomSourceSrtFileName')}
                              {...field}
                              value={field.value || '${fileName}.${sourceLanguage}'}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  )}
                </div>
              </fieldset>
            </TabsContent>
          )}

          {/* 翻译设置 Tab */}
          {showTranslationSettings && (
            <TabsContent value="translation" className="mt-4">
              <fieldset className="grid gap-4 rounded-lg border p-4">
                <div className="grid gap-3">
                  <FormField
                    control={form.control}
                    name="translateProvider"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between space-x-4">
                        <FormLabel className="flex-shrink-0 mt-2">{t('translationService')}</FormLabel>
                        <FormControl>
                          <Select
                            onValueChange={(value) => {
                              field.onChange(value);
                            }}
                            value={field.value}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={'-1'}>{t('Untranslate')}</SelectItem>
                              {providers.map((provider) => (
                                <SelectItem key={provider.id} value={provider.id}>
                                  {tCommon(`provider.${provider.name}`, {
                                    defaultValue: provider.name,
                                  })}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-3">
                  <div className="grid gap-3">
                    <FormField
                      control={form.control}
                      name="targetLanguage"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between space-x-4">
                          <FormLabel className="flex-shrink-0 mt-2">{t('translationTargetLanguage')}</FormLabel>
                          <FormControl>
                            <Select
                              onValueChange={field.onChange}
                              value={field.value}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder={t('pleaseSelect')} />
                              </SelectTrigger>
                              <SelectContent>
                                {supportedLanguage.map((item) => (
                                  <SelectItem key={item.value} value={item.value}>
                                    {tCommon(`language.${item.value}`)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
                <div className="grid gap-3">
                  <FormField
                    control={form.control}
                    name="translateContent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {t('translationOutputSubtitleSettings')}
                        </FormLabel>
                        <FormControl>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
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
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-3">
                  <FormField
                    control={form.control}
                    name="targetSrtSaveOption"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center">
                          {t('translationSubtitleSaveSettings')}
                          <SavePathNotice />
                        </FormLabel>
                        <FormControl>
                          <Select
                            onValueChange={field.onChange}
                            value={field.value || 'fileNameWithLang'}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={t('pleaseSelect')} />
                            </SelectTrigger>
                            <SelectContent>
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
                        </FormControl>
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
                              placeholder={t('pleaseInputCustomTargetSrtFileName')}
                              {...field}
                              value={field.value || '${fileName}.${targetLanguage}'}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  )}
                  <div className="grid gap-3">
                    <FormField
                      control={form.control}
                      name="translateRetryTimes"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between space-x-4">
                          <FormLabel className="flex-shrink-0 mt-2">{t('translateRetryTimes')}</FormLabel>
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
                </div>
              </fieldset>
            </TabsContent>
          )}

          {/* 高级设置 Tab */}
          <TabsContent value="advanced" className="mt-4">
            <fieldset className="grid gap-4 rounded-lg border p-4">
              <FormField
                control={form.control}
                name="maxConcurrentTasks"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between space-x-4">
                    <FormLabel className="flex-shrink-0 mt-2">{t('maxConcurrentTasks')}</FormLabel>
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
              <FormField
                control={form.control}
                name="saveAudio"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md p-2">
                    <FormControl>
                      <div className="flex items-center space-x-2">
                        <Input
                          type="checkbox"
                          checked={field.value || false}
                          onChange={field.onChange}
                          className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                        />
                        <FormLabel className="font-normal">
                          {t('saveAudio')}
                        </FormLabel>
                      </div>
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

export default TaskConfigForm;
