import React, { useEffect, useState } from 'react';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import {
  FASTER_WHISPER_ADVANCED_PARAM_SPECS,
  isValidFasterWhisperAdvancedParamValue,
  type FasterWhisperAdvancedParamSpec,
  type FasterWhisperAdvancedSettingKey,
} from '../../../../types/transcriptionParams';

function formatAdvancedNumberDraft(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : '';
}

/**
 * 独立草稿避免数值输入的负号/小数中间态被受控 value 立即改写。
 * 编辑中即时展示错误但不把非法值写进任务配置；失焦时非法值清空，确保任务永远只拿到
 * 合法数字或 undefined（undefined = 沿用引擎默认）。
 */
const FasterWhisperAdvancedNumberField: React.FC<{
  form: any;
  spec: FasterWhisperAdvancedParamSpec;
  field: any;
}> = ({ form, spec, field }) => {
  const { t } = useTranslation('tasks');
  const [draft, setDraft] = useState(() =>
    formatAdvancedNumberDraft(field.value),
  );
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraft(formatAdvancedNumberDraft(field.value));
    }
  }, [editing, field.value]);

  const validationMessage = t(
    spec.integer
      ? 'fasterWhisperAdvanced.integerRangeError'
      : 'fasterWhisperAdvanced.rangeError',
    {
      min: spec.min,
      max: spec.max,
    },
  );

  const updateFormValue = (raw: string) => {
    if (raw.trim() === '') {
      form.setValue(spec.settingKey, undefined, {
        shouldDirty: true,
        shouldValidate: true,
      });
      form.clearErrors(spec.settingKey);
      return;
    }

    const nextValue = Number(raw);
    if (isValidFasterWhisperAdvancedParamValue(nextValue, spec)) {
      form.setValue(spec.settingKey, nextValue, {
        shouldDirty: true,
        shouldValidate: true,
      });
      form.clearErrors(spec.settingKey);
      return;
    }

    // 草稿可暂时非法，但任务配置始终回落 undefined，防止快捷键开跑或持久化脏值。
    form.setValue(spec.settingKey, undefined, {
      shouldDirty: true,
      shouldValidate: false,
    });
    form.setError(spec.settingKey, {
      type: 'validate',
      message: validationMessage,
    });
  };

  return (
    <FormItem>
      <FormLabel>
        {t(`fasterWhisperAdvanced.fields.${spec.runtimeKey}.label`)}
      </FormLabel>
      <FormControl>
        <Input
          type="text"
          inputMode={spec.integer ? 'numeric' : 'decimal'}
          value={draft}
          placeholder={t(
            `fasterWhisperAdvanced.fields.${spec.runtimeKey}.placeholder`,
          )}
          onFocus={() => setEditing(true)}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            updateFormValue(raw);
          }}
          onBlur={() => {
            setEditing(false);
            const parsed = draft.trim() === '' ? undefined : Number(draft);
            if (
              parsed === undefined ||
              !isValidFasterWhisperAdvancedParamValue(parsed, spec)
            ) {
              setDraft('');
              form.setValue(spec.settingKey, undefined, {
                shouldDirty: true,
                shouldValidate: true,
              });
            } else {
              setDraft(String(parsed));
              form.setValue(spec.settingKey, parsed, {
                shouldDirty: true,
                shouldValidate: true,
              });
            }
            field.onBlur();
          }}
        />
      </FormControl>
      <FormDescription className="text-xs">
        {t(`fasterWhisperAdvanced.fields.${spec.runtimeKey}.hint`)}
      </FormDescription>
      <FormMessage />
    </FormItem>
  );
};

const FasterWhisperAdvancedFields: React.FC<{ form: any }> = ({ form }) => {
  const { t } = useTranslation('tasks');

  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
      >
        <span className="space-y-0.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t('fasterWhisperAdvanced.title')}
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              faster-whisper
            </Badge>
          </span>
          <span className="block text-xs font-normal text-muted-foreground">
            {t('fasterWhisperAdvanced.summary')}
          </span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t px-3 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('fasterWhisperAdvanced.description')}
        </p>
        <p className="rounded-md bg-muted/60 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          {t('fasterWhisperAdvanced.runtimeNote')}
        </p>
        {FASTER_WHISPER_ADVANCED_PARAM_SPECS.map((spec) => (
          <FormField
            key={spec.settingKey}
            control={form.control}
            name={spec.settingKey}
            rules={{
              validate: (value) =>
                value === undefined ||
                value === '' ||
                isValidFasterWhisperAdvancedParamValue(value, spec) ||
                t(
                  spec.integer
                    ? 'fasterWhisperAdvanced.integerRangeError'
                    : 'fasterWhisperAdvanced.rangeError',
                  {
                    min: spec.min,
                    max: spec.max,
                  },
                ),
            }}
            render={({ field }) => (
              <FasterWhisperAdvancedNumberField
                form={form}
                spec={spec}
                field={field}
              />
            )}
          />
        ))}
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => {
            FASTER_WHISPER_ADVANCED_PARAM_SPECS.forEach((spec) => {
              form.setValue(
                spec.settingKey as FasterWhisperAdvancedSettingKey,
                undefined,
                { shouldDirty: true, shouldValidate: true },
              );
            });
          }}
        >
          {t('fasterWhisperAdvanced.reset')}
        </button>
      </CollapsibleContent>
    </Collapsible>
  );
};

export default FasterWhisperAdvancedFields;
