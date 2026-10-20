import React from 'react';
import { FormControl, FormField, FormItem } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'next-i18next';
import SavePathNotice from '@/components/SavePathNotice';
import ManuscriptControl from '@/components/tasks/ManuscriptControl';
import EmbeddedSubtitleControl from '@/components/tasks/EmbeddedSubtitleControl';
import SettingsGroup from '@/components/tasks/settings/SettingsGroup';
import SettingRow from '@/components/tasks/settings/SettingRow';
import type { TaskTypeDef } from 'lib/taskTypes';
import { isSherpaEngine } from 'lib/subtitleOutcome';
import { correctedSourceSrtSaveOption } from '../../../../types/sourceSrtSave';

/** A select that sits at the right of a row. */
const SELECT_CLASS = 'h-8 w-[184px] text-xs';

interface CommonSettingsProps {
  form: any;
  formData: any;
  typeDef: TaskTypeDef;
  /** The wizard can hold a task whose input is only subtitle files. */
  hasMediaInput: boolean;
  /** `null` while the speaker model status is still being read. */
  diarizationReady: boolean | null;
}

/**
 * 更多设置 › 常用: what an ordinary user changes now and then, in the order a task runs.
 * Every row is one setting in one place (the toolbar already owns the output format, the
 * output content, the segmentation and the scenario), and a row that only matters while
 * another one is on appears with it, so the page shows what applies to this task and
 * nothing else. Hiding a row never touches the value it holds.
 */
export default function CommonSettings({
  form,
  formData,
  typeDef,
  hasMediaInput,
  diarizationReady,
}: CommonSettingsProps) {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');

  const isMediaTask = typeDef.accepts === 'media';
  const engine = formData?.transcriptionEngine as string | undefined;
  const serialTranscribe = engine === 'fasterWhisper' || isSherpaEngine(engine);

  const showSource = typeDef.needsModel && hasMediaInput;
  const showAssist = isMediaTask || hasMediaInput;
  const showTranslationStyle = typeDef.hasTranslate;
  // Only the AI correction pass reads the filler policy.
  const showFillerPolicy = isMediaTask && formData?.aiCorrection === true;
  const showPolish = showTranslationStyle || showFillerPolicy;
  const isGenerateOnly = typeDef.taskType === 'generateOnly';

  // 并发语义按引擎明示：受限引擎转写阶段全局排队；云端受服务商级全局闸约束
  const concurrencyHint = serialTranscribe
    ? tHome('maxConcurrentTasksHintSerialTranscribe')
    : engine === 'cloud'
      ? tHome('maxConcurrentTasksHintCloud')
      : undefined;

  return (
    <div className="space-y-6" data-testid="settings-common">
      {showSource && (
        <SettingsGroup
          title={t('settings.groups.source')}
          testId="settings-group-source"
        >
          {/* 视频自带文本字幕轨时直接提取、跳过识别；决定了专家页里的识别参数对哪些视频生效 */}
          <EmbeddedSubtitleControl
            enabled={formData?.useEmbeddedSubtitles !== false}
            onEnabledChange={(checked) =>
              form.setValue('useEmbeddedSubtitles', checked, {
                shouldDirty: true,
              })
            }
          />
        </SettingsGroup>
      )}

      {showAssist && (
        <SettingsGroup
          title={t('settings.groups.assist')}
          testId="settings-group-assist"
        >
          {isMediaTask && <ManuscriptControl form={form} formData={formData} />}

          {isMediaTask && (
            <FormField
              control={form.control}
              name="prompt"
              render={({ field }) => (
                <SettingRow
                  stacked
                  label={tHome('prompt')}
                  hint={tHome('promptTips').replace(/<br\s*\/?>/g, '')}
                >
                  <FormControl>
                    <Textarea
                      placeholder={tHome('pleaseInput')}
                      {...field}
                      value={field.value || ''}
                      className="min-h-[60px] text-xs"
                    />
                  </FormControl>
                </SettingRow>
              )}
            />
          )}

          {hasMediaInput && (
            <FormField
              control={form.control}
              name="speakerDiarization"
              render={({ field }) => (
                <div className="space-y-2.5">
                  <SettingRow
                    label={t('speakerDiarization.label')}
                    hint={t('speakerDiarization.hint')}
                    adornment={
                      diarizationReady !== null && (
                        <Badge
                          variant="outline"
                          className={
                            diarizationReady
                              ? 'border-success/40 text-success'
                              : 'border-amber-500/40 text-amber-600'
                          }
                        >
                          {t(
                            diarizationReady
                              ? 'speakerDiarization.modelReady'
                              : 'speakerDiarization.modelMissing',
                          )}
                        </Badge>
                      )
                    }
                  >
                    <FormControl>
                      <Switch
                        checked={field.value === true}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingRow>
                  {field.value === true && (
                    <div
                      data-testid="speaker-diarization-details"
                      className="ml-1 space-y-2.5 border-l pl-3"
                    >
                      <FormField
                        control={form.control}
                        name="speakerDiarizationCount"
                        render={({ field: countField }) => (
                          <SettingRow
                            label={t('speakerDiarization.speakerCount')}
                            hint={t('speakerDiarization.speakerCountHint')}
                          >
                            <Select
                              value={String(countField.value || 0)}
                              onValueChange={(value) =>
                                countField.onChange(Number(value))
                              }
                            >
                              <FormControl>
                                <SelectTrigger className="h-8 w-28 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="0">
                                  {t('speakerDiarization.autoDetect')}
                                </SelectItem>
                                {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                                  <SelectItem key={count} value={String(count)}>
                                    {count}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </SettingRow>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="speakerDiarizationEmbedInSubtitle"
                        render={({ field: embedField }) => (
                          <SettingRow
                            label={t('speakerDiarization.embedInSubtitle')}
                            hint={t('speakerDiarization.embedInSubtitleHint')}
                          >
                            <FormControl>
                              <Switch
                                checked={embedField.value === true}
                                onCheckedChange={embedField.onChange}
                              />
                            </FormControl>
                          </SettingRow>
                        )}
                      />
                      {diarizationReady === false && (
                        <p className="text-xs text-amber-600">
                          {t('speakerDiarization.modelMissingHint')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            />
          )}
        </SettingsGroup>
      )}

      {showPolish && (
        <SettingsGroup
          title={t('settings.groups.translate')}
          testId="settings-group-translate"
        >
          {showTranslationStyle && (
            <FormField
              control={form.control}
              name="subtitleTranslationStyle"
              render={({ field }) => (
                <SettingRow label={t('presets.language.translation')}>
                  <Select
                    value={field.value || 'neutral'}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger className={SELECT_CLASS}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="neutral">
                        {t('presets.language.neutral')}
                      </SelectItem>
                      <SelectItem value="conversational">
                        {t('presets.language.conversational')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
              )}
            />
          )}

          {showFillerPolicy && (
            <FormField
              control={form.control}
              name="subtitleFillerPolicy"
              render={({ field }) => (
                <SettingRow
                  label={t('presets.language.fillers')}
                  testId="setting-filler-policy"
                >
                  <Select
                    value={field.value || 'legacy'}
                    onValueChange={(value) =>
                      field.onChange(value === 'legacy' ? undefined : value)
                    }
                  >
                    <FormControl>
                      <SelectTrigger className={SELECT_CLASS}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="legacy">
                        {t('presets.language.legacy')}
                      </SelectItem>
                      <SelectItem value="remove-hesitations">
                        {t('presets.language.removeHesitations')}
                      </SelectItem>
                      <SelectItem value="preserve">
                        {t('presets.language.preserve')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
              )}
            />
          )}
        </SettingsGroup>
      )}

      <SettingsGroup
        title={t('settings.groups.output')}
        testId="settings-group-output"
      >
        {isMediaTask && (
          <>
            <FormField
              control={form.control}
              name="sourceSrtSaveOption"
              render={({ field }) => {
                // generateOnly 任务的源字幕即交付物，noSave 选项被隐藏；残留的 noSave / 空值在这里
                // 读成 fileName（下拉框不会显示为空）。这只是显示：表单里的值不动，因为向导里
                // 同一份表单还会被切到「翻译」，那时不保存才是对的；提交时由各入口按同一规则修正
                // （任务页改表单，向导与下载流水线改提交的配置，见 correctedSourceSrtSaveOption）。
                const sourceSaveValue =
                  correctedSourceSrtSaveOption(typeDef.taskType, field.value) ??
                  (field.value || 'fileName');
                return (
                  <SettingRow
                    label={tHome('sourceSubtitleSaveSettings')}
                    adornment={<SavePathNotice />}
                    testId="setting-source-save"
                  >
                    <Select
                      onValueChange={field.onChange}
                      value={sourceSaveValue}
                    >
                      <FormControl>
                        <SelectTrigger className={SELECT_CLASS}>
                          <SelectValue placeholder={tHome('pleaseSelect')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {!isGenerateOnly && (
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
                  </SettingRow>
                );
              }}
            />
            {formData?.sourceSrtSaveOption === 'custom' && (
              <FormField
                control={form.control}
                name="customSourceSrtFileName"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        aria-label={tHome('pleaseInputCustomSourceSrtFileName')}
                        placeholder={tHome(
                          'pleaseInputCustomSourceSrtFileName',
                        )}
                        className="h-8 text-xs"
                        {...field}
                        value={field.value || '${fileName}.${sourceLanguage}'}
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
                <SettingRow
                  label={tHome('translationSubtitleSaveSettings')}
                  adornment={<SavePathNotice />}
                  testId="setting-target-save"
                >
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || 'fileNameWithLang'}
                  >
                    <FormControl>
                      <SelectTrigger className={SELECT_CLASS}>
                        <SelectValue placeholder={tHome('pleaseSelect')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {typeDef.taskType === 'generateAndTranslate' && (
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
                </SettingRow>
              )}
            />
            {formData?.targetSrtSaveOption === 'custom' && (
              <FormField
                control={form.control}
                name="customTargetSrtFileName"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        aria-label={tHome('pleaseInputCustomTargetSrtFileName')}
                        placeholder={tHome(
                          'pleaseInputCustomTargetSrtFileName',
                        )}
                        className="h-8 text-xs"
                        {...field}
                        value={field.value || '${fileName}.${targetLanguage}'}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}
          </>
        )}

        <FormField
          control={form.control}
          name="subtitleLayout"
          render={({ field }) => (
            <SettingRow label={t('presets.layout.label')}>
              <Select
                value={field.value || 'original'}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger className={SELECT_CLASS}>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="original">
                    {t('presets.layout.original')}
                  </SelectItem>
                  <SelectItem value="two-line">
                    {t('presets.layout.twoLine')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          )}
        />
        {formData?.subtitleLayout === 'two-line' && (
          <FormField
            control={form.control}
            name="subtitleLineWidth"
            render={({ field }) => (
              <SettingRow
                stacked
                label={t('presets.layout.width')}
                trailing={
                  <span className="text-xs tabular-nums">
                    {field.value || 42}
                  </span>
                }
              >
                <FormControl>
                  <Slider
                    aria-label={t('presets.layout.width')}
                    min={16}
                    max={80}
                    step={1}
                    value={[field.value || 42]}
                    onValueChange={([value]) => field.onChange(value)}
                  />
                </FormControl>
              </SettingRow>
            )}
          />
        )}

        {(isMediaTask || typeDef.hasTranslate) && (
          <FormField
            control={form.control}
            name="removeChinesePunctuation"
            render={({ field }) => (
              <SettingRow
                label={t('chinesePunctuation.label')}
                hint={t('chinesePunctuation.hint')}
              >
                <FormControl>
                  <Switch
                    checked={field.value === true}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </SettingRow>
            )}
          />
        )}

        {isMediaTask && (
          <FormField
            control={form.control}
            name="saveAudio"
            render={({ field }) => (
              <SettingRow
                label={tHome('saveAudio')}
                hint={tHome('saveAudioTip')}
              >
                <FormControl>
                  <Switch
                    checked={field.value === true}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </SettingRow>
            )}
          />
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t('settings.groups.run')}
        testId="settings-group-run"
      >
        <FormField
          control={form.control}
          name="maxConcurrentTasks"
          render={({ field }) => (
            <SettingRow
              label={tHome('maxConcurrentTasks')}
              hint={concurrencyHint}
              testId="setting-max-concurrent"
            >
              <FormControl>
                <Input
                  type="number"
                  placeholder={tHome('pleaseInputMaxConcurrentTasks')}
                  className="h-8 w-20 text-right text-xs"
                  {...field}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                  min={1}
                  value={field.value || 1}
                />
              </FormControl>
            </SettingRow>
          )}
        />
        {typeDef.hasTranslate && (
          <FormField
            control={form.control}
            name="translateRetryTimes"
            render={({ field }) => (
              <SettingRow label={tHome('translateRetryTimes')}>
                <FormControl>
                  <Input
                    type="number"
                    placeholder={tHome('pleaseInput')}
                    className="h-8 w-20 text-right text-xs"
                    {...field}
                    value={field.value || 0}
                  />
                </FormControl>
              </SettingRow>
            )}
          />
        )}
      </SettingsGroup>
    </div>
  );
}
