import Link from 'next/link';
import { useTranslation } from 'next-i18next';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/panel';

const STEPS = ['import', 'configure', 'result'] as const;

/** 用最简单的原文字幕任务串起导入、配置与结果，供首次使用时照着操作。 */
export default function QuickStartGuide({ locale }: { locale: string }) {
  const { t } = useTranslation('launchpad');

  return (
    <Panel className="min-h-fit flex-1" aria-label={t('quickStart.title')}>
      <PanelHeader title={t('quickStart.title')} />
      <div className="flex flex-1 flex-col px-3 pb-3">
        <p className="mb-2 text-xs leading-4 text-muted-foreground">
          {t('quickStart.intro')}
        </p>
        <ol className="space-y-1.5">
          {STEPS.map((step, index) => (
            <li key={step} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="tnum flex h-5 w-5 flex-none items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-medium leading-5">
                  {t(`quickStart.${step}.title`)}
                </h3>
                <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                  {t(`quickStart.${step}.description`)}
                </p>
                {step === 'configure' && (
                  <Link
                    href={`/${locale}/engines`}
                    className="mt-0.5 inline-block rounded-sm text-xs leading-4 text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('quickStart.configure.models')}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className="pt-3">
          <Button asChild size="sm" className="w-full gap-1.5">
            <Link href={`/${locale}/tasks/generate`}>
              {t('quickStart.start')}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>
    </Panel>
  );
}
