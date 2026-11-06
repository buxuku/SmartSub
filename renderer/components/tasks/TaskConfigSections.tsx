import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AudioLines, Film, FileText, ListChecks } from 'lucide-react';
import { useTtsEngineOptions } from '../../hooks/useTtsEngineOptions';
import useComposeOptions, {
  type ComposeOptions,
} from '../../hooks/useComposeOptions';
import { dubbingEngineKey } from '../../lib/pipelineSettings';
import {
  ComposeSettings,
  DubbingSettings,
  ReviewSettings,
} from './settings/PipelineSettings';

interface Props {
  form: {
    setValue: (
      name: string,
      value: any,
      options?: { shouldDirty: boolean },
    ) => void;
  };
  formData: Record<string, any>;
  disabled: boolean;
  composePreferences?: ComposeOptions['preferences'];
  children: React.ReactNode;
}

export default function TaskConfigSections(props: Props) {
  if (!props.formData.dub && !props.formData.compose)
    return <>{props.children}</>;
  return <PipelineSections {...props} />;
}

function PipelineSections({
  form,
  formData,
  disabled,
  children,
  composePreferences,
}: Props) {
  const { t } = useTranslation('tasks');
  const [section, setSection] = useState('subtitle');
  const { engineOptions } = useTtsEngineOptions();
  const composeOptions = useComposeOptions(Boolean(formData.compose));
  const translateOn =
    formData.taskType !== 'generateOnly' && formData.translateProvider !== '-1';
  const dub = formData.dub;
  const compose = formData.compose;
  const engine = engineOptions.find(
    (option) => option.key === dubbingEngineKey(dub?.engine),
  );
  const voice = engine?.voices.find((option) => option.id === dub?.voice);
  const groups = [
    {
      key: 'subtitle',
      label: t(
        translateOn
          ? 'stageSettings.subtitleTranslate'
          : 'stageSettings.subtitle',
      ),
      icon: FileText,
      summary: [
        formData.sourceLanguage,
        ...(translateOn ? ['→', formData.targetLanguage] : []),
      ]
        .filter(Boolean)
        .join(' '),
    },
    ...(dub
      ? [
          {
            key: 'dubbing',
            label: t('stageSettings.dubbing'),
            icon: AudioLines,
            summary: [
              engine?.label || dubbingEngineKey(dub.engine),
              voice?.label || dub.voice,
              `${dub.globalSpeed ?? 1}x`,
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ]
      : []),
    ...(compose
      ? [
          {
            key: 'compose',
            label: t('stageSettings.compose'),
            icon: Film,
            summary: [
              t(
                compose.subtitle === 'soft'
                  ? 'wizard.composeSoft'
                  : compose.subtitle === 'none'
                    ? 'wizard.composeNone'
                    : 'wizard.composeHard',
              ),
              ...(compose.subtitle === 'hard' ? [compose.styleName] : []),
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ]
      : []),
    {
      key: 'review',
      label: t('stageSettings.review'),
      icon: ListChecks,
      summary:
        [
          formData.gates?.subtitle === 'manual' ? t('wizard.gateSubtitle') : '',
          dub && formData.gates?.dubbing === 'manual'
            ? t('wizard.gateDubbing')
            : '',
        ]
          .filter(Boolean)
          .join(' · ') || t('stageSettings.automatic'),
    },
  ];
  const active = groups.some((group) => group.key === section)
    ? section
    : 'subtitle';
  const update = (name: string, value: any) => {
    if (!disabled) form.setValue(name, value, { shouldDirty: true });
  };
  const flow = [
    t('stageSettings.subtitle'),
    ...(translateOn ? [t('stage.translate')] : []),
    ...(dub ? [t('stage.dubbing')] : []),
    ...(compose ? [t('stage.compose')] : []),
  ];
  return (
    <div
      className="min-w-0 rounded-lg border bg-muted/20 p-3"
      data-testid="task-config-sections"
    >
      <p
        className="mb-2 text-xs text-muted-foreground"
        data-testid="task-flow-summary"
      >
        {flow.join(' → ')}
      </p>
      <Tabs value={active} onValueChange={setSection} className="min-w-0">
        <TabsList
          aria-label={t('stageSettings.label')}
          className="grid h-auto w-full grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] items-stretch gap-2 bg-transparent p-0"
        >
          {groups.map((group) => (
            <TabsTrigger
              key={group.key}
              value={group.key}
              aria-label={group.label}
              className="h-auto min-h-14 min-w-0 justify-start gap-2 rounded-md border px-3 py-2 text-left data-[state=active]:border-primary/40"
            >
              <group.icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block whitespace-normal text-xs leading-4">
                  {group.label}
                </span>
                <span
                  className="block max-w-full truncate text-[11px] font-normal leading-4 text-muted-foreground"
                  title={group.summary}
                >
                  {group.summary}
                </span>
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="subtitle" className="mt-3 min-w-0">
          {children}
        </TabsContent>
        {dub && (
          <TabsContent value="dubbing" className="mt-3">
            <DubbingSettings
              value={dub}
              onChange={(value) => update('dub', value)}
              engines={engineOptions}
              subtitleLanguage={
                translateOn ? formData.targetLanguage : formData.sourceLanguage
              }
              disabled={disabled}
            />
          </TabsContent>
        )}
        {compose && (
          <TabsContent value="compose" className="mt-3">
            <ComposeSettings
              value={compose}
              onChange={(value) => update('compose', value)}
              options={
                composePreferences
                  ? { ...composeOptions, preferences: composePreferences }
                  : composeOptions
              }
              dubEnabled={Boolean(dub)}
              translateOn={translateOn}
              translateContent={formData.translateContent}
              disabled={disabled}
            />
          </TabsContent>
        )}
        <TabsContent value="review" className="mt-3">
          <ReviewSettings
            value={formData.gates || {}}
            onChange={(value) => update('gates', value)}
            dubEnabled={Boolean(dub)}
            disabled={disabled}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
