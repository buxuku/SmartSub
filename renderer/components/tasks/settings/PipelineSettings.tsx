import React from 'react';
import { useTranslation } from 'next-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import SettingsFields from './SettingsFields';
import DubbingLanguageSelect from '../../dubbing/DubbingLanguageSelect';
import ComposeContentHint from '../wizard/ComposeContentHint';
import { STYLE_PRESETS } from '../../subtitleMerge/constants';
import {
  dubbingEngineKey,
  selectComposeStyle,
  withComposeDefaults,
} from '../../../lib/pipelineSettings';
import {
  parseEngineKey,
  type DubbingEngineOption,
} from '../../../hooks/useTtsEngineOptions';
import type { ComposeOptions } from '../../../hooks/useComposeOptions';
import type {
  PipelineComposeConfig,
  PipelineDubConfig,
  PipelineGatesConfig,
} from '../../../../types';
import {
  localTtsLanguageError,
  resolveTtsLanguage,
} from '../../../../types/ttsLanguage';

type Option = { value: string; label: string; disabled?: boolean };
function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
  width = 144,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  width?: number;
}) {
  const { t } = useTranslation('tasks');
  const choices =
    value && !options.some((option) => option.value === value)
      ? [
          {
            value,
            label: `${value} (${t('stageSettings.savedValue')})`,
            disabled: true,
          },
          ...options,
        ]
      : options;
  return (
    <div
      className="min-w-0 space-y-1"
      style={{ flexBasis: width }}
      title={choices.find((option) => option.value === value)?.label}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <Select
        value={value}
        onValueChange={(next) => {
          if (!disabled) onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label={label}
          className="h-8 w-full min-w-0 text-xs"
        >
          <SelectValue placeholder={t('stageSettings.choose')} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function DubbingSettings({
  value,
  onChange,
  engines,
  subtitleLanguage,
  disabled = false,
}: {
  value: Partial<PipelineDubConfig>;
  onChange: (value: Partial<PipelineDubConfig>) => void;
  engines: DubbingEngineOption[];
  subtitleLanguage?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('tasks');
  const { t: common } = useTranslation('common');
  const { t: dub } = useTranslation('dubbing');
  const key = dubbingEngineKey(value.engine);
  const engine = engines.find((option) => option.key === key);
  const voice = engine?.voices.find((option) => option.id === value.voice);
  const automaticLanguage = resolveTtsLanguage({
    subtitleLanguage,
    voiceLanguage: voice?.lang,
  });
  const language = resolveTtsLanguage({
    language: value.language,
    subtitleLanguage: automaticLanguage,
  });
  const languageError =
    value.engine?.kind === 'local'
      ? localTtsLanguageError(value.engine.modelId, language)
      : undefined;
  const change = (patch: Partial<PipelineDubConfig>) => {
    if (!disabled) onChange({ ...value, ...patch });
  };
  return (
    <div className="space-y-2">
      <SettingsFields disabled={disabled}>
        <Choice
          width={160}
          label={t('wizard.dubEngine')}
          value={key}
          disabled={disabled}
          options={engines.map((option) => ({
            value: option.key,
            label: `${option.label}${option.ready ? '' : ` (${t('wizard.notReady')})`}`,
            disabled: !option.ready,
          }))}
          onChange={(next) => {
            const option = engines.find((item) => item.key === next);
            const engine = parseEngineKey(next);
            if (engine)
              change({
                engine,
                voice: option?.defaultVoiceId || option?.voices[0]?.id || '',
              });
          }}
        />
        <Choice
          width={160}
          label={t('wizard.dubVoice')}
          value={value.voice || ''}
          disabled={disabled || !engine?.ready}
          options={(engine?.voices || []).map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          onChange={(voice) => change({ voice })}
        />
        <div className="min-w-0 space-y-1" style={{ flexBasis: 96 }}>
          <div className="text-xs text-muted-foreground">
            {common('ttsLanguage')}
          </div>
          <DubbingLanguageSelect
            className="h-8 text-xs"
            value={value.language}
            resolved={automaticLanguage}
            disabled={disabled}
            onChange={(language) => change({ language })}
          />
        </div>
        <Choice
          width={72}
          label={t('wizard.dubSpeed')}
          value={String(value.globalSpeed ?? 1)}
          disabled={disabled}
          options={Array.from(
            new Set([0.75, 0.9, 1, 1.1, 1.25, 1.5, value.globalSpeed ?? 1]),
          )
            .sort((a, b) => a - b)
            .map((speed) => ({ value: String(speed), label: `${speed}x` }))}
          onChange={(speed) => change({ globalSpeed: Number(speed) })}
        />
        {value.engine?.kind === 'local' && (
          <Choice
            label={dub('localConcurrency')}
            value={String(value.localConcurrency ?? 1)}
            disabled={disabled}
            options={[1, 2, 3].map((count) => ({
              value: String(count),
              label: String(count),
            }))}
            onChange={(count) => change({ localConcurrency: Number(count) })}
          />
        )}
        {engine?.cloneOnly && (
          <Choice
            label={dub('cloneQuality')}
            value={value.cloneQuality || 'standard'}
            disabled={disabled}
            options={[
              { value: 'standard', label: dub('cloneQualityStandard') },
              { value: 'high', label: dub('cloneQualityHigh') },
            ]}
            onChange={(quality) =>
              change({
                cloneQuality: quality as PipelineDubConfig['cloneQuality'],
              })
            }
          />
        )}
        <Choice
          width={160}
          label={dub('overflow')}
          value={value.overflow || 'truncate'}
          disabled={disabled}
          options={[
            { value: 'truncate', label: dub('overflowTruncate') },
            { value: 'shift', label: dub('overflowShift') },
          ]}
          onChange={(overflow) =>
            change({ overflow: overflow as PipelineDubConfig['overflow'] })
          }
        />
        <Choice
          width={160}
          label={dub('overlapMode')}
          value={value.overlapMode || 'shift'}
          disabled={disabled}
          options={[
            { value: 'shift', label: dub('overlapShift') },
            { value: 'mix', label: dub('overlapMix') },
          ]}
          onChange={(overlapMode) =>
            change({
              overlapMode: overlapMode as PipelineDubConfig['overlapMode'],
            })
          }
        />
      </SettingsFields>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        {key && (!engine?.ready || !voice) && (
          <p role="status" className="text-xs text-warning">
            {t('stageSettings.dubbingUnavailable')}
          </p>
        )}
        {languageError && (
          <p role="status" className="text-xs text-warning">
            {common('ttsLanguageUnsupported', { language: languageError })}
          </p>
        )}
        {engine?.kind === 'cloud' && (
          <p className="text-xs text-muted-foreground">
            {t('wizard.dubBillingHint')}
          </p>
        )}
      </div>
    </div>
  );
}

export function ComposeSettings({
  value,
  onChange,
  options,
  dubEnabled,
  translateOn,
  translateContent,
  disabled = false,
}: {
  value: PipelineComposeConfig;
  onChange: (value: PipelineComposeConfig) => void;
  options: ComposeOptions;
  dubEnabled: boolean;
  translateOn: boolean;
  translateContent?: unknown;
  disabled?: boolean;
}) {
  const { t } = useTranslation('tasks');
  const { t: merge } = useTranslation('subtitleMerge');
  const effective = withComposeDefaults(value, options.preferences);
  const change = (patch: Partial<PipelineComposeConfig>) => {
    if (!disabled) onChange({ ...value, ...patch });
  };
  const styles = [
    ...STYLE_PRESETS.map((preset) => ({
      value: preset.id,
      label: merge(preset.nameKey) || preset.name,
    })),
    ...options.styles.map((preset) => ({
      value: preset.id,
      label: preset.name,
    })),
  ];
  if (value.styleId && !styles.some((style) => style.value === value.styleId))
    styles.unshift({
      value: value.styleId,
      label: value.styleName || value.styleId,
    });
  return (
    <div className="space-y-2">
      <SettingsFields disabled={disabled}>
        <Choice
          width={160}
          label={t('wizard.composeSubtitle')}
          value={value.subtitle}
          disabled={disabled}
          options={[
            { value: 'hard', label: t('wizard.composeHard') },
            { value: 'soft', label: t('wizard.composeSoft') },
            {
              value: 'none',
              label: t('wizard.composeNone'),
              disabled: !dubEnabled,
            },
          ]}
          onChange={(subtitle) =>
            change({ subtitle: subtitle as PipelineComposeConfig['subtitle'] })
          }
        />
        {value.subtitle === 'hard' && (
          <>
            <Choice
              width={160}
              label={t('wizard.composeStyle')}
              value={value.styleId || ''}
              disabled={disabled}
              options={styles}
              onChange={(id) => {
                if (!disabled)
                  onChange(
                    selectComposeStyle(value, id, options.styles, merge),
                  );
              }}
            />
            <Choice
              width={104}
              label={t('wizard.composeQuality')}
              value={effective.videoQuality}
              disabled={disabled}
              options={[
                { value: 'original', label: merge('videoQualityOriginal') },
                { value: 'high', label: merge('videoQualityHigh') },
                { value: 'standard', label: merge('videoQualityStandard') },
              ]}
              onChange={(videoQuality) =>
                change({
                  videoQuality:
                    videoQuality as PipelineComposeConfig['videoQuality'],
                })
              }
            />
            <Choice
              width={104}
              label={t('wizard.composeEncoder')}
              value={effective.encoderMode}
              disabled={disabled}
              options={[
                { value: 'cpu', label: merge('encoderModeCpu') },
                {
                  value: 'hardware',
                  label: merge('encoderModeHardware'),
                  disabled: !options.hwInfo?.available,
                },
              ]}
              onChange={(encoderMode) =>
                change({
                  encoderMode:
                    encoderMode as PipelineComposeConfig['encoderMode'],
                })
              }
            />
          </>
        )}
      </SettingsFields>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        {value.subtitle === 'hard' && value.style && (
          <p className="text-xs text-muted-foreground">
            {t('stageSettings.styleSnapshot')}
          </p>
        )}
        {value.subtitle === 'hard' &&
          effective.encoderMode === 'hardware' &&
          options.loaded &&
          !options.hwInfo?.available && (
            <p className="text-xs text-warning">
              {t('wizard.composeEncoderUnavailable')}
            </p>
          )}
        {options.error && (
          <p role="status" className="text-xs text-warning">
            {t('stageSettings.composeOptionsUnavailable')}
          </p>
        )}
        {dubEnabled && (
          <p className="text-xs text-muted-foreground">
            {t('wizard.composeAudioHint')}
          </p>
        )}
        <ComposeContentHint
          translateOn={translateOn}
          composeSubtitle={value.subtitle}
          translateContent={translateContent}
        />
      </div>
    </div>
  );
}

export function ReviewSettings({
  value,
  onChange,
  dubEnabled,
  disabled = false,
}: {
  value: PipelineGatesConfig;
  onChange: (value: PipelineGatesConfig) => void;
  dubEnabled: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation('tasks');
  return (
    <div className="space-y-3">
      {(['subtitle', ...(dubEnabled ? ['dubbing'] : [])] as const).map(
        (gate) => {
          const key = gate as keyof PipelineGatesConfig;
          const label =
            gate === 'subtitle' ? 'wizard.gateSubtitle' : 'wizard.gateDubbing';
          return (
            <label key={gate} className="flex items-center gap-2 text-xs">
              <Switch
                aria-label={t(label)}
                disabled={disabled}
                checked={value[key] === 'manual'}
                onCheckedChange={(checked) => {
                  if (!disabled)
                    onChange({ ...value, [key]: checked ? 'manual' : 'auto' });
                }}
              />
              <span>{t(label)}</span>
              <span className="text-muted-foreground">{t(`${label}Desc`)}</span>
            </label>
          );
        },
      )}
      <p className="text-xs text-muted-foreground">{t('wizard.gatesHint')}</p>
    </div>
  );
}
