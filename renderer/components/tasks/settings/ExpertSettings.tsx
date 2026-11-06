import React from 'react';
import { ChevronDown } from 'lucide-react';
import {
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
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useTranslation } from 'next-i18next';
import SettingsGroup from '@/components/tasks/settings/SettingsGroup';
import SettingRow from '@/components/tasks/settings/SettingRow';
import FasterWhisperAdvancedFields from '@/components/tasks/settings/FasterWhisperAdvancedFields';
import {
  SUBTITLE_OUTCOME_TIERS,
  inferDisplayOutcome,
  isSherpaEngine,
  resolveEffectiveSettings,
  supportsOutcomeStrategy,
  supportsTaskVadField,
  TASK_VAD_SPECS,
  type SubtitleOutcome,
} from 'lib/subtitleOutcome';
import {
  convertToCustomOutcome,
  leaveCustomOutcome,
} from '@/lib/scenarioPresets';
import { supportsFasterWhisperAdvancedParams } from '../../../../types/transcriptionParams';

/** 断句精调的两根滑块：范围与"没设过"时的显示值。 */
const SEGMENT_TUNING_SLIDERS = [
  { key: 'subtitleMaxDuration', min: 0.5, max: 30, step: 0.5, fallback: 8 },
  { key: 'subtitleMaxGap', min: 0, max: 5, step: 0.05, fallback: 0.5 },
] as const;

interface ExpertSettingsProps {
  form: any;
  formData: any;
  /** 全局设置，面板打开时读一次：老任务缺省值的显示回退，也用来推断显示的档位。 */
  settings: Record<string, unknown>;
}

/**
 * 更多设置 › 专家: what only makes sense once you know how the recognizer works. The
 * strategy tier is the one thing here that ordinary users used to meet first; they now get
 * a sensible tier from the scenario and only come here to override it.
 */
export default function ExpertSettings({
  form,
  formData,
  settings,
}: ExpertSettingsProps) {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');

  const engine = formData?.transcriptionEngine as string | undefined;
  const sherpa = isSherpaEngine(engine);
  const usesStrategy = supportsOutcomeStrategy(engine);

  // 自定义档的 VAD 开关 / 抗重复是**任务级**（写入 react-hook-form → userConfig），
  // 不回写全局，避免在某个任务里调一下就污染其它任务与两个 whisper 引擎。
  // 迁移回退：任务级缺省时，开关初始显示沿用全局旧值（默认 VAD 开、抗重复关）。
  const vadFallback = settings?.useVAD !== false;
  const reduceFallback = settings?.reduceRepetition === true;

  // 当前档位：任务级显式值优先，否则按既有旋钮推断一个友好的显示默认（不写回）。
  const currentOutcome: SubtitleOutcome = inferDisplayOutcome(
    {
      subtitleOutcome: formData?.subtitleOutcome,
      maxContext: formData?.maxContext,
    },
    settings,
  );
  const effectiveSettings = resolveEffectiveSettings(formData, settings);

  return (
    <div className="space-y-6" data-testid="settings-expert">
      <SettingsGroup
        title={t('settings.groups.strategy')}
        testId="settings-group-strategy"
      >
        {usesStrategy ? (
          <>
            {/* 识别策略：把 上下文/VAD/抗重复 收敛成一个意图单选（任务级）。场景已经带了合适的档位，
                这里只给想覆盖它的人 */}
            <FormField
              control={form.control}
              name="subtitleOutcome"
              render={({ field }) => (
                <SettingRow
                  label={t('outcome.label')}
                  hint={t('settings.strategy.hint')}
                  testId="setting-outcome"
                >
                  <Select
                    value={currentOutcome}
                    onValueChange={(tier) => {
                      if (tier === 'custom')
                        convertToCustomOutcome(
                          form,
                          form.getValues(),
                          settings,
                        );
                      else if (currentOutcome === 'custom')
                        leaveCustomOutcome(
                          form,
                          tier as Exclude<SubtitleOutcome, 'custom'>,
                        );
                      else field.onChange(tier);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger
                        className="h-8 w-[184px] text-xs"
                        data-testid="outcome-select"
                      >
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {([...SUBTITLE_OUTCOME_TIERS, 'custom'] as const).map(
                        (tier) => (
                          <SelectItem key={tier} value={tier}>
                            {t(`outcome.${tier}.title`)}
                            {tier === 'balanced' && (
                              <span className="ml-1.5 text-muted-foreground">
                                {t('outcome.recommended')}
                              </span>
                            )}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </SettingRow>
              )}
            />
            <div
              data-testid="outcome-description"
              className="space-y-1 rounded-md bg-muted/40 px-3 py-2"
            >
              <p className="text-xs leading-relaxed text-foreground/90">
                {t(
                  currentOutcome === 'accurate' && engine === 'fasterWhisper'
                    ? 'outcome.accurate.fasterWhisperDesc'
                    : `outcome.${currentOutcome}.desc`,
                )}
              </p>
              {currentOutcome !== 'custom' && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t(`outcome.${currentOutcome}.scene`)}
                </p>
              )}
            </div>

            {/* 手动调节：选中即在下方展开底层旋钮
                （sherpa 系隐藏不适用的上下文/抗重复，VAD 结构性常开） */}
            {currentOutcome === 'custom' && (
              <div
                data-testid="outcome-manual"
                className="space-y-3 rounded-lg border border-dashed p-3"
              >
                <p className="text-xs font-medium text-muted-foreground">
                  {t('outcome.custom.sectionTitle')}
                </p>
                {sherpa ? (
                  <p className="text-xs text-muted-foreground">
                    {t('outcome.custom.sherpaNote')}
                  </p>
                ) : (
                  <>
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
                      name="useVAD"
                      render={({ field }) => {
                        const checked =
                          typeof field.value === 'boolean'
                            ? field.value
                            : vadFallback;
                        return (
                          <FormItem className="space-y-2 rounded-lg border p-2">
                            <div className="flex flex-row items-center justify-between gap-2">
                              <div className="space-y-0.5">
                                <FormLabel className="text-sm font-medium">
                                  {t('vad.label')}
                                </FormLabel>
                                <p className="text-xs text-muted-foreground">
                                  {checked ? t('vad.on') : t('vad.off')}
                                </p>
                              </div>
                              <FormControl>
                                <Switch
                                  checked={checked}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {t('vad.hint')}
                            </p>
                          </FormItem>
                        );
                      }}
                    />
                    <FormField
                      control={form.control}
                      name="reduceRepetition"
                      render={({ field }) => {
                        const checked =
                          typeof field.value === 'boolean'
                            ? field.value
                            : reduceFallback;
                        return (
                          <FormItem className="space-y-2 rounded-lg border p-2">
                            <div className="flex flex-row items-center justify-between gap-2">
                              <div className="space-y-0.5">
                                <FormLabel className="text-sm font-medium">
                                  {t('reduceRepetition.label')}
                                </FormLabel>
                                <p className="text-xs text-muted-foreground">
                                  {checked
                                    ? t('reduceRepetition.on')
                                    : t('reduceRepetition.off')}
                                </p>
                              </div>
                              <FormControl>
                                <Switch
                                  checked={checked}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {t('reduceRepetition.hint')}
                            </p>
                          </FormItem>
                        );
                      }}
                    />
                  </>
                )}
                {(sherpa || formData?.useVAD !== false) &&
                  TASK_VAD_SPECS.filter((spec) =>
                    supportsTaskVadField(engine, spec.key),
                  ).map((spec) => (
                    <FormField
                      key={spec.key}
                      control={form.control}
                      name={spec.key}
                      render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center justify-between gap-3">
                            <FormLabel>
                              {t(`presets.controls.${spec.key}`)}
                            </FormLabel>
                            <span className="text-xs tabular-nums">
                              {Number(
                                field.value ??
                                  effectiveSettings[spec.key] ??
                                  spec.fallback,
                              )}
                            </span>
                          </div>
                          <FormControl>
                            <Slider
                              aria-label={t(`presets.controls.${spec.key}`)}
                              min={spec.min}
                              max={spec.max}
                              step={spec.step}
                              value={[
                                Number(
                                  field.value ??
                                    effectiveSettings[spec.key] ??
                                    spec.fallback,
                                ),
                              ]}
                              onValueChange={([value]) => field.onChange(value)}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  ))}
              </div>
            )}

            {/* 样例对比（静态示意，帮助理解「文字最准 ↔ 最干净最稳」的取舍） */}
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs text-muted-foreground hover:text-foreground">
                <span>{t('outcome.compare.toggle')}</span>
                <ChevronDown className="h-3.5 w-3.5" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <p className="text-[11px] text-muted-foreground">
                    {t('outcome.compare.caption')}
                  </p>
                  {SUBTITLE_OUTCOME_TIERS.map((tier) => (
                    <div key={tier} className="flex gap-2 text-xs">
                      <span className="w-16 shrink-0 font-medium text-muted-foreground">
                        {t(`outcome.${tier}.title`)}
                      </span>
                      <span className="flex-1 text-foreground">
                        “{t(`outcome.compare.${tier}`)}”
                      </span>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        ) : (
          // 云端听写、本地命令行不读识别策略：不给选择，免得选了没有效果
          <p
            data-testid="outcome-unsupported"
            className="rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
          >
            {t('settings.strategy.unsupported')}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t('settings.groups.segmentTuning')}
        testId="settings-group-segment-tuning"
      >
        {SEGMENT_TUNING_SLIDERS.map((spec) => (
          <FormField
            key={spec.key}
            control={form.control}
            name={spec.key}
            render={({ field }) => (
              <SettingRow
                stacked
                label={t(`presets.controls.${spec.key}`)}
                testId={`setting-${spec.key}`}
                trailing={
                  <span className="text-xs tabular-nums">
                    {Number(field.value ?? spec.fallback)}
                  </span>
                }
              >
                <FormControl>
                  <Slider
                    aria-label={t(`presets.controls.${spec.key}`)}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    value={[Number(field.value ?? spec.fallback)]}
                    onValueChange={([value]) => field.onChange(value)}
                  />
                </FormControl>
              </SettingRow>
            )}
          />
        ))}
        <FormField
          control={form.control}
          name="preserveSpeechPauses"
          render={({ field }) => (
            <SettingRow label={t('presets.controls.preserveSpeechPauses')}>
              <FormControl>
                <Switch
                  checked={field.value === true}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </SettingRow>
          )}
        />
      </SettingsGroup>

      {supportsFasterWhisperAdvancedParams(engine) && (
        <SettingsGroup
          title={t('settings.groups.decoding')}
          testId="settings-group-decoding"
        >
          <FasterWhisperAdvancedFields form={form} />
        </SettingsGroup>
      )}
    </div>
  );
}
