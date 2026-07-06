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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { cn } from 'lib/utils';
import SavePathNotice from '@/components/SavePathNotice';
import type { TaskTypeDef } from 'lib/taskTypes';
import {
  SUBTITLE_OUTCOME_TIERS,
  inferDisplayOutcome,
  isSherpaEngine,
  type SubtitleOutcome,
} from 'lib/subtitleOutcome';
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

type SubtitleLengthMode = 'smart' | 'unlimited' | 'custom';

/**
 * 「字幕断句方式」三态选择（共用 maxSubtitleChars 字段，数字编码不暴露给用户）：
 * 智能断句 = 0；不限制长度 = -1；自定义字数上限 = 正数（8-120）。
 * 自定义数字走本地草稿：输入框清空时不回写 0，避免模式瞬间塌回「智能断句」。
 */
const SubtitleLengthField: React.FC<{
  field: { value?: unknown; onChange: (value: number) => void };
}> = ({ field }) => {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');
  const raw = Number(field.value ?? 0);
  const mode: SubtitleLengthMode =
    raw < 0 ? 'unlimited' : raw > 0 ? 'custom' : 'smart';
  const [draft, setDraft] = useState<string>(raw > 0 ? String(raw) : '40');
  useEffect(() => {
    if (raw > 0) setDraft(String(raw));
  }, [raw]);

  return (
    <FormItem>
      <FormLabel>{t('subtitleLength.label')}</FormLabel>
      <Select
        value={mode}
        onValueChange={(value) => {
          if (value === 'unlimited') {
            field.onChange(-1);
          } else if (value === 'custom') {
            const parsed = Number(draft);
            field.onChange(parsed > 0 ? Math.round(parsed) : 40);
          } else {
            field.onChange(0);
          }
        }}
      >
        <FormControl>
          <SelectTrigger>
            <SelectValue placeholder={tHome('pleaseSelect')} />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value="smart">{t('subtitleLength.modeSmart')}</SelectItem>
          <SelectItem value="unlimited">
            {t('subtitleLength.modeUnlimited')}
          </SelectItem>
          <SelectItem value="custom">
            {t('subtitleLength.modeCustom')}
          </SelectItem>
        </SelectContent>
      </Select>
      {mode === 'custom' && (
        <Input
          type="number"
          min={8}
          max={120}
          value={draft}
          onChange={(e) => {
            const value = e.target.value;
            setDraft(value);
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0) {
              field.onChange(Math.round(parsed));
            }
          }}
        />
      )}
      <FormDescription className="text-xs">
        {mode === 'smart' && t('subtitleLength.hintSmart')}
        {mode === 'unlimited' && t('subtitleLength.hintUnlimited')}
        {mode === 'custom' && t('subtitleLength.hintCustom')}
      </FormDescription>
    </FormItem>
  );
};

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

  const engine = formData?.transcriptionEngine as string | undefined;
  const sherpa = isSherpaEngine(engine);

  // 自定义档的 VAD 开关 / 抗重复改为**任务级**（写入 react-hook-form → userConfig），
  // 不再回写全局，避免在某个任务里调一下就污染其它任务与两个 whisper 引擎。
  // 仍读一次全局 settings：① 作为老任务（formData 无该字段）的迁移回退显示值；
  // ② 供 inferDisplayOutcome 在任务无显式档位时推断显示默认。
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (!open) return;
    let active = true;
    (async () => {
      const s = await window?.ipc?.invoke('getSettings');
      if (active) setSettings(s ?? {});
    })();
    return () => {
      active = false;
    };
  }, [open]);
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

                      {/* 字幕效果档位：把 上下文/VAD/抗重复 收敛成一个意图单选（任务级） */}
                      <FormField
                        control={form.control}
                        name="subtitleOutcome"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('outcome.label')}</FormLabel>
                            <div className="grid gap-2">
                              {(
                                [...SUBTITLE_OUTCOME_TIERS, 'custom'] as const
                              ).map((tier) => {
                                const selected = currentOutcome === tier;
                                return (
                                  <button
                                    type="button"
                                    key={tier}
                                    onClick={() => field.onChange(tier)}
                                    className={cn(
                                      'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                                      selected
                                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                        : 'hover:bg-accent',
                                    )}
                                  >
                                    <div
                                      className={cn(
                                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                                        selected
                                          ? 'border-primary bg-primary text-primary-foreground'
                                          : 'border-muted-foreground/40',
                                      )}
                                    >
                                      {selected && (
                                        <Check className="h-3 w-3" />
                                      )}
                                    </div>
                                    <div className="space-y-0.5">
                                      <div className="flex items-center gap-2">
                                        {tier === 'custom' && (
                                          <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                                        )}
                                        <span className="text-sm font-medium">
                                          {t(`outcome.${tier}.title`)}
                                        </span>
                                        {tier === 'balanced' && (
                                          <Badge
                                            variant="secondary"
                                            className="px-1.5 py-0 text-[10px]"
                                          >
                                            {t('outcome.recommended')}
                                          </Badge>
                                        )}
                                      </div>
                                      <p className="text-xs text-muted-foreground">
                                        {t(`outcome.${tier}.desc`)}
                                      </p>
                                      {tier !== 'custom' && (
                                        <p className="text-[11px] text-muted-foreground/80">
                                          {t(`outcome.${tier}.scene`)}
                                        </p>
                                      )}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </FormItem>
                        )}
                      />

                      {/* 自定义档：紧贴档位选择器，选中即在下方展开底层旋钮
                          （sherpa 系隐藏不适用的上下文/抗重复，VAD 结构性常开） */}
                      {currentOutcome === 'custom' && (
                        <div className="space-y-3 rounded-lg border border-dashed p-3">
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
                                            {checked
                                              ? t('vad.on')
                                              : t('vad.off')}
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
                                <span className="flex-1 text-foreground/90">
                                  “{t(`outcome.compare.${tier}`)}”
                                </span>
                              </div>
                            ))}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>

                      <FormField
                        control={form.control}
                        name="maxSubtitleChars"
                        render={({ field }) => (
                          <SubtitleLengthField field={field} />
                        )}
                      />

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
                        {/* 并发语义按引擎明示：受限引擎转写阶段全局排队；云端受服务商级全局闸约束 */}
                        {(engine === 'fasterWhisper' || sherpa) && (
                          <FormDescription className="text-xs">
                            {tHome('maxConcurrentTasksHintSerialTranscribe')}
                          </FormDescription>
                        )}
                        {engine === 'cloud' && (
                          <FormDescription className="text-xs">
                            {tHome('maxConcurrentTasksHintCloud')}
                          </FormDescription>
                        )}
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
