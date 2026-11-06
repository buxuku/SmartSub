import React, { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Form } from '@/components/ui/form';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'next-i18next';
import type { TaskTypeDef } from 'lib/taskTypes';
import {
  applyScenarioPreset,
  getScenarioPresetDef,
  getScenarioState,
} from '@/lib/scenarioPresets';
import CommonSettings from '@/components/tasks/settings/CommonSettings';
import ExpertSettings from '@/components/tasks/settings/ExpertSettings';
import type { TaskSettingsTab } from '@/components/tasks/settings/types';

interface TaskSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: any;
  formData: any;
  typeDef: TaskTypeDef;
  hasMediaInput?: boolean;
  /**
   * The page showing. The task page and the wizard own it so that reopening 更多设置
   * returns to where the user left, and so that a link can ask for a page; without it the
   * sheet remembers the page on its own.
   */
  tab?: TaskSettingsTab;
  onTabChange?: (tab: TaskSettingsTab) => void;
}

/** "已调整": the same dot the scenario button wears. */
function AdjustedDot({ testId }: { testId: string }) {
  const { t } = useTranslation('tasks');
  return (
    <>
      <span
        aria-hidden="true"
        data-testid={testId}
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
      />
      <span className="sr-only">{t('presets.adjusted')}</span>
    </>
  );
}

/**
 * 更多设置: everything the toolbar does not carry, in two pages. 常用 is for the user who
 * wants to name the output or turn on speaker diarization; 专家 is for the one who knows
 * what a VAD threshold does. The toolbar keeps the settings every task needs (model,
 * language, scenario, segmentation, translation, output), so nothing here repeats it.
 * A task that only translates has no scenario and nothing to tune, so it gets one page and
 * no tabs.
 */
const TaskSettingsSheet: React.FC<TaskSettingsSheetProps> = ({
  open,
  onOpenChange,
  form,
  formData,
  typeDef,
  hasMediaInput = typeDef.accepts === 'media',
  tab,
  onTabChange,
}) => {
  const { t } = useTranslation('tasks');

  const isMediaTask = typeDef.accepts === 'media';

  const [ownTab, setOwnTab] = useState<TaskSettingsTab>('common');
  const activeTab: TaskSettingsTab = isMediaTask ? (tab ?? ownTab) : 'common';
  const changeTab = (next: TaskSettingsTab) => {
    if (onTabChange) onTabChange(next);
    else setOwnTab(next);
  };

  // 自定义档的 VAD 开关 / 抗重复是任务级，不再回写全局。仍读一次全局 settings：
  // ① 作为老任务（formData 无该字段）的迁移回退显示值；② 供 inferDisplayOutcome 在任务
  // 无显式档位时推断显示默认。
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [diarizationReady, setDiarizationReady] = useState<boolean | null>(
    null,
  );
  useEffect(() => {
    if (!open || !isMediaTask) return;
    let active = true;
    (async () => {
      const s = await window?.ipc?.invoke('getSettings');
      if (active) setSettings(s ?? {});
    })();
    return () => {
      active = false;
    };
  }, [open, isMediaTask]);
  useEffect(() => {
    if (!open || !hasMediaInput) return;
    let active = true;
    window?.ipc
      ?.invoke('getSpeakerDiarizationModelStatus')
      .then((result) => {
        if (active) {
          setDiarizationReady(
            result?.installed === true && result?.runtimeInstalled === true,
          );
        }
      })
      .catch(() => {
        if (active) setDiarizationReady(false);
      });
    return () => {
      active = false;
    };
  }, [open, hasMediaInput]);

  const scenario = getScenarioState(formData);
  const scenarioDef = getScenarioPresetDef(scenario.presetId);
  const scenarioName = scenarioDef
    ? t(scenarioDef.nameKey)
    : t('presets.balanced.name');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[420px] max-w-full sm:max-w-[420px] p-0 focus:outline-none"
        // Radix would focus the first tabbable element. On a page without tabs that can be
        // the ⓘ next to a label, and focusing an ⓘ opens its tooltip: the panel opens with a
        // hint over the first row, and that tooltip swallows the first Escape. Park focus
        // on the panel instead; Tab still starts at the first control. The panel is not a
        // control, so it draws no focus ring of its own (opened from the keyboard, the
        // browser would outline the whole sheet); the controls inside keep theirs.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <Tabs
          value={activeTab}
          onValueChange={(value) => changeTab(value as TaskSettingsTab)}
          className="flex h-full min-h-0 flex-col"
        >
          <SheetHeader className="space-y-1 px-6 pb-3 pt-6">
            <SheetTitle>{t('settings.title')}</SheetTitle>
            <SheetDescription className="text-xs">
              {t('settings.description')}
            </SheetDescription>
          </SheetHeader>

          {isMediaTask && (
            <div className="space-y-3 px-6 pb-3">
              <div
                data-testid="settings-summary"
                className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-xs"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="flex-none text-muted-foreground">
                    {t('settings.summary.scenario')}
                  </span>
                  <strong
                    data-testid="settings-summary-scenario"
                    className="truncate font-semibold text-foreground"
                  >
                    {scenarioName}
                  </strong>
                  {scenario.adjusted && (
                    <span
                      data-testid="settings-summary-adjusted"
                      className="flex flex-none items-center gap-1 text-muted-foreground"
                    >
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full bg-warning"
                      />
                      {t('settings.summary.adjusted', {
                        count: scenario.groups.length,
                      })}
                    </span>
                  )}
                </div>
                {scenario.adjusted && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="settings-summary-restore"
                    className="h-7 flex-none gap-1 px-2 text-xs font-normal"
                    onClick={() => applyScenarioPreset(form, scenario.presetId)}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('settings.summary.restore')}
                  </Button>
                )}
              </div>

              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="common" data-testid="settings-tab-common">
                  {t('settings.tabs.common')}
                </TabsTrigger>
                <TabsTrigger value="expert" data-testid="settings-tab-expert">
                  {t('settings.tabs.expert')}
                  {scenario.expertAdjusted && (
                    <AdjustedDot testId="settings-expert-dot" />
                  )}
                </TabsTrigger>
              </TabsList>
            </div>
          )}

          {/* 内边距放在视口内部：避免输入框 focus ring 被 ScrollArea 视口横向裁剪。
              以 tab 为 key：两页共用一个滚动视口，不换 key 的话，切页会停在上一页留下的
              滚动位置，常用页的第一组就被卷到视口上方。 */}
          <ScrollArea key={activeTab} className="min-h-0 flex-1">
            <div className="px-6 pb-6 pt-1">
              <Form {...form}>
                <form onSubmit={(event) => event.preventDefault()}>
                  {isMediaTask ? (
                    <>
                      <TabsContent value="common" className="mt-0">
                        <CommonSettings
                          form={form}
                          formData={formData}
                          typeDef={typeDef}
                          hasMediaInput={hasMediaInput}
                          diarizationReady={diarizationReady}
                        />
                      </TabsContent>
                      <TabsContent value="expert" className="mt-0">
                        <ExpertSettings
                          form={form}
                          formData={formData}
                          settings={settings}
                        />
                      </TabsContent>
                    </>
                  ) : (
                    <CommonSettings
                      form={form}
                      formData={formData}
                      typeDef={typeDef}
                      hasMediaInput={hasMediaInput}
                      diarizationReady={diarizationReady}
                    />
                  )}
                </form>
              </Form>
            </div>
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
};

export default TaskSettingsSheet;
