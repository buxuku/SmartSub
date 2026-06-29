import React, { useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import SavePathNotice from '@/components/SavePathNotice';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';

interface AdvancedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: any;
  formData: any;
  typeDef: TaskTypeDef;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground pt-2">
      {children}
    </h4>
  );
}

const AdvancedSheet: React.FC<AdvancedSheetProps> = ({
  open,
  onOpenChange,
  form,
  formData,
  typeDef,
}) => {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');

  const isMediaTask = typeDef.accepts === 'media';
  const showFormatHere = typeDef.hasTranslate; // generateOnly 已在配置条展示

  // VAD 是全局设置（settings.useVAD），与设置页同源；这里只是任务高级选项里的便捷入口。
  // 不进 react-hook-form，避免与逐任务的 userConfig 混淆。
  const [vadEnabled, setVadEnabled] = useState(true);
  const [reduceRepetition, setReduceRepetition] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    (async () => {
      const s = await window?.ipc?.invoke('getSettings');
      if (active) {
        setVadEnabled(s?.useVAD !== false);
        setReduceRepetition(s?.reduceRepetition === true);
      }
    })();
    return () => {
      active = false;
    };
  }, [open]);
  const handleVadChange = async (checked: boolean) => {
    setVadEnabled(checked);
    await window?.ipc?.invoke('setSettings', { useVAD: checked });
  };
  const handleReduceRepetitionChange = async (checked: boolean) => {
    setReduceRepetition(checked);
    await window?.ipc?.invoke('setSettings', { reduceRepetition: checked });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px] p-0">
        <div className="flex h-full flex-col">
          <SheetHeader className="px-6 pt-6">
            <SheetTitle>{t('advanced')}</SheetTitle>
            <SheetDescription>{t('advancedDesc')}</SheetDescription>
          </SheetHeader>
          {/* 内边距放在视口内部：避免输入框 focus ring 被 ScrollArea 视口横向裁剪 */}
          <ScrollArea className="flex-1">
            <div className="px-6 pb-6">
              <Form {...form}>
                <form className="grid gap-4 pt-4">
                  {isMediaTask && (
                    <>
                      <SectionTitle>{t('section.recognition')}</SectionTitle>
                      <FormField
                        control={form.control}
                        name="prompt"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{tHome('prompt')}</FormLabel>
                            <FormControl>
                              <Textarea
                                placeholder={tHome('pleaseInput')}
                                {...field}
                                value={field.value || ''}
                                className="min-h-[60px]"
                              />
                            </FormControl>
                            <FormDescription className="text-xs">
                              {tHome('promptTips').replace(/<br\s*\/?>/g, '')}
                            </FormDescription>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="maxContext"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{tHome('maxContext')}</FormLabel>
                            <Select
                              onValueChange={(value) =>
                                field.onChange(Number(value))
                              }
                              value={String(field.value ?? -1)}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue
                                    placeholder={tHome('pleaseSelect')}
                                  />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="-1">
                                  {tHome('noLimit')}
                                </SelectItem>
                                <SelectItem value="0">
                                  {tHome('noContext')}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <FormDescription className="text-xs">
                              {tHome('maxContextTip')}
                            </FormDescription>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="saveAudio"
                        render={({ field }) => (
                          <FormItem className="flex flex-row items-center justify-between rounded-lg border p-2">
                            <div className="space-y-0.5">
                              <FormLabel>{tHome('saveAudio')}</FormLabel>
                              <FormDescription className="text-xs">
                                {tHome('saveAudioTip')}
                              </FormDescription>
                            </div>
                            <FormControl>
                              <Switch
                                checked={field.value}
                                onCheckedChange={field.onChange}
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <div className="space-y-2 rounded-lg border p-2">
                        <div className="flex flex-row items-center justify-between gap-2">
                          <div className="space-y-0.5">
                            <p className="text-sm font-medium">
                              {t('vad.label')}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {vadEnabled ? t('vad.on') : t('vad.off')}
                            </p>
                          </div>
                          <Switch
                            checked={vadEnabled}
                            onCheckedChange={handleVadChange}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('vad.hint')}
                        </p>
                      </div>
                      <div className="space-y-2 rounded-lg border p-2">
                        <div className="flex flex-row items-center justify-between gap-2">
                          <div className="space-y-0.5">
                            <p className="text-sm font-medium">
                              {t('reduceRepetition.label')}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {reduceRepetition
                                ? t('reduceRepetition.on')
                                : t('reduceRepetition.off')}
                            </p>
                          </div>
                          <Switch
                            checked={reduceRepetition}
                            onCheckedChange={handleReduceRepetitionChange}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('reduceRepetition.hint')}
                        </p>
                      </div>
                    </>
                  )}

                  <SectionTitle>{t('section.output')}</SectionTitle>
                  {isMediaTask && (
                    <>
                      <FormField
                        control={form.control}
                        name="sourceSrtSaveOption"
                        render={({ field }) => {
                          // generateOnly 任务的源字幕即交付物，noSave 选项被隐藏；
                          // 若残留 noSave/空值会让下拉框显示为空且任务结束后删除字幕，这里回退为 fileName
                          const isGenerateOnly =
                            typeDef.taskType === 'generateOnly';
                          const sourceSaveValue =
                            isGenerateOnly &&
                            (!field.value || field.value === 'noSave')
                              ? 'fileName'
                              : field.value || 'fileName';
                          return (
                            <FormItem>
                              <FormLabel className="flex items-center">
                                {tHome('sourceSubtitleSaveSettings')}
                                <SavePathNotice />
                              </FormLabel>
                              <Select
                                onValueChange={field.onChange}
                                value={sourceSaveValue}
                              >
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue
                                      placeholder={tHome('pleaseSelect')}
                                    />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {typeDef.taskType !== 'generateOnly' && (
                                    <SelectItem value="noSave">
                                      {tHome('noSave')}
                                    </SelectItem>
                                  )}
                                  <SelectItem value="fileName">
                                    {tHome('fileName')}
                                  </SelectItem>
                                  <SelectItem value="fileNameWithLang">
                                    {tHome('fileNameWithLang')}
                                  </SelectItem>
                                  <SelectItem value="custom">
                                    {tHome('customSettings')}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </FormItem>
                          );
                        }}
                      />
                      {formData.sourceSrtSaveOption === 'custom' && (
                        <FormField
                          control={form.control}
                          name="customSourceSrtFileName"
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  placeholder={tHome(
                                    'pleaseInputCustomSourceSrtFileName',
                                  )}
                                  {...field}
                                  value={
                                    field.value ||
                                    '${fileName}.${sourceLanguage}'
                                  }
                                />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                      )}
                    </>
                  )}

                  {typeDef.hasTranslate && (
                    <>
                      <FormField
                        control={form.control}
                        name="targetSrtSaveOption"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center">
                              {tHome('translationSubtitleSaveSettings')}
                              <SavePathNotice />
                            </FormLabel>
                            <Select
                              onValueChange={field.onChange}
                              value={field.value || 'fileNameWithLang'}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue
                                    placeholder={tHome('pleaseSelect')}
                                  />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {typeDef.taskType ===
                                  'generateAndTranslate' && (
                                  <SelectItem value="fileName">
                                    {tHome('fileName')}
                                  </SelectItem>
                                )}
                                <SelectItem value="fileNameWithLang">
                                  {tHome('fileNameWithLang')}
                                </SelectItem>
                                <SelectItem value="custom">
                                  {tHome('customSettings')}
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
                                  placeholder={tHome(
                                    'pleaseInputCustomTargetSrtFileName',
                                  )}
                                  {...field}
                                  value={
                                    field.value ||
                                    '${fileName}.${targetLanguage}'
                                  }
                                />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                      )}
                      <FormField
                        control={form.control}
                        name="translationDictionary"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('dictionary.label')}</FormLabel>
                            <FormControl>
                              <Textarea
                                placeholder={t('dictionary.placeholder')}
                                {...field}
                                value={field.value || ''}
                                className="min-h-[104px] font-mono text-xs"
                              />
                            </FormControl>
                            <FormDescription className="text-xs">
                              {t('dictionary.hint')}
                            </FormDescription>
                          </FormItem>
                        )}
                      />
                    </>
                  )}

                  {(isMediaTask || typeDef.hasTranslate) && (
                    <FormField
                      control={form.control}
                      name="removeChinesePunctuation"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-2">
                          <div className="space-y-0.5">
                            <FormLabel>
                              {t('chinesePunctuation.label')}
                            </FormLabel>
                            <FormDescription className="text-xs">
                              {t('chinesePunctuation.hint')}
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value === true}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  )}

                  {showFormatHere && (
                    <FormField
                      control={form.control}
                      name="subtitleOutputFormat"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tHome('subtitleOutputFormat')}</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            value={field.value || 'srt'}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={tHome('pleaseSelect')}
                                />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="srt">
                                {tHome('format_srt')}
                              </SelectItem>
                              <SelectItem value="vtt">
                                {tHome('format_vtt')}
                              </SelectItem>
                              <SelectItem value="ass">
                                {tHome('format_ass')}
                              </SelectItem>
                              <SelectItem value="lrc">
                                {tHome('format_lrc')}
                              </SelectItem>
                              <SelectItem value="txt">
                                {tHome('format_txt')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <FormDescription className="text-xs">
                            {tHome('subtitleOutputFormatTip')}
                          </FormDescription>
                        </FormItem>
                      )}
                    />
                  )}

                  <SectionTitle>{t('section.execution')}</SectionTitle>
                  <FormField
                    control={form.control}
                    name="maxConcurrentTasks"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{tHome('maxConcurrentTasks')}</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            placeholder={tHome('pleaseInputMaxConcurrentTasks')}
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number(e.target.value))
                            }
                            min={1}
                            value={field.value || 1}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  {typeDef.hasTranslate && (
                    <FormField
                      control={form.control}
                      name="translateRetryTimes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tHome('translateRetryTimes')}</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              placeholder={tHome('pleaseInput')}
                              {...field}
                              value={field.value || 0}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  )}
                </form>
              </Form>
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default AdvancedSheet;
