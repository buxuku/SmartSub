import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  AlertTriangle,
  Clapperboard,
  Edit3,
  Film,
  Languages,
  Subtitles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from 'lib/utils';
import {
  getTaskTypeBySlug,
  getTaskTypeByValue,
  type TaskTypeDef,
} from 'lib/taskTypes';
import { isProviderConfigured } from 'lib/providerUtils';
import {
  getFileStages,
  getStageStatus,
  isFileDone,
  hasFileError,
} from '@/components/tasks/stageUtils';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { useTranslation } from 'next-i18next';

interface CardDef {
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  chip: string;
  /** /tasks/[slug] 卡片 */
  slug?: string;
  /** 直达页面卡片 */
  href?: string;
  needsModel?: boolean;
}

const CARDS: CardDef[] = [
  {
    key: 'generateTranslate',
    slug: 'generate-translate',
    icon: Subtitles,
    chip: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    needsModel: true,
  },
  {
    key: 'generate',
    slug: 'generate',
    icon: Clapperboard,
    chip: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    needsModel: true,
  },
  {
    key: 'translate',
    slug: 'translate',
    icon: Languages,
    chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  {
    key: 'proofread',
    href: 'proofread',
    icon: Edit3,
    chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  {
    key: 'merge',
    href: 'subtitleMerge',
    icon: Film,
    chip: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  },
];

type RecentStatus = 'waiting' | 'running' | 'done' | 'error';

const STATUS_DOT: Record<RecentStatus, string> = {
  waiting: 'bg-muted-foreground/40',
  running: 'bg-blue-500',
  done: 'bg-green-500',
  error: 'bg-red-500',
};

function getRecentStatus(
  file: any,
  typeDef: TaskTypeDef,
  userConfig: any,
): RecentStatus {
  const stages = getFileStages(file, typeDef, userConfig);
  if (isFileDone(file, stages)) return 'done';
  if (hasFileError(file, stages)) return 'error';
  if (stages.some((s) => getStageStatus(file, s.key) === 'loading')) {
    return 'running';
  }
  return 'waiting';
}

export default function LaunchpadPage() {
  const router = useRouter();
  const { locale } = router.query;
  const { t } = useTranslation('launchpad');
  const [hasModels, setHasModels] = useState(true);
  const [hasProvider, setHasProvider] = useState(true);
  const [recentFiles, setRecentFiles] = useState<any[]>([]);
  const [userConfig, setUserConfig] = useState<any>({});
  const [dragCard, setDragCard] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [systemInfo, providers, tasks, config, settings] =
          await Promise.all([
            window?.ipc?.invoke('getSystemInfo', null),
            window?.ipc?.invoke('getTranslationProviders'),
            window?.ipc?.invoke('getTasks'),
            window?.ipc?.invoke('getUserConfig'),
            window?.ipc?.invoke('getSettings'),
          ]);
        const useLocalWhisper = settings?.useLocalWhisper || false;
        setHasModels(
          useLocalWhisper || (systemInfo?.modelsInstalled?.length ?? 0) > 0,
        );
        setHasProvider(
          (providers || []).some((p: any) => isProviderConfigured(p)),
        );
        setRecentFiles((tasks || []).slice(-5).reverse());
        setUserConfig(config || {});
      } catch (error) {
        console.error('Failed to load launchpad data:', error);
      }
    };
    load();
  }, []);

  const currentTypeDef =
    getTaskTypeByValue(userConfig?.taskType) ||
    getTaskTypeBySlug('generate-translate');

  const cardTarget = (card: CardDef) =>
    card.slug ? `/${locale}/tasks/${card.slug}` : `/${locale}/${card.href}`;

  const handleCardDrop = async (e: React.DragEvent, card: CardDef) => {
    e.preventDefault();
    setDragCard(null);
    if (!card.slug) return;
    const typeDef = getTaskTypeBySlug(card.slug);
    if (!typeDef) return;

    const paths: string[] = [];
    const droppedFiles = e.dataTransfer.files;
    for (let i = 0; i < droppedFiles.length; i++) {
      // @ts-ignore - Electron File 对象包含 path 属性，支持文件和文件夹
      const filePath = droppedFiles[i].path;
      if (filePath) {
        paths.push(filePath);
      }
    }
    if (!paths.length) {
      router.push(cardTarget(card));
      return;
    }

    const dropped = await window?.ipc?.invoke('getDroppedFiles', {
      files: paths,
      taskType: typeDef.accepts === 'subtitle' ? 'translate' : 'media',
    });
    const existing = (await window?.ipc?.invoke('getTasks')) || [];
    window?.ipc?.send('setTasks', [...existing, ...(dropped || [])]);
    router.push(cardTarget(card));
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 space-y-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>

        {!hasModels && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex-wrap">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <p className="text-sm min-w-0 flex-1">{t('banner.noModel')}</p>
            <Button asChild size="sm" className="h-8 flex-shrink-0">
              <Link href={`/${locale}/resources?tab=models`}>
                {t('banner.noModelCta')}
              </Link>
            </Button>
          </div>
        )}
        {hasModels && !hasProvider && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex-wrap">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <p className="text-sm min-w-0 flex-1">{t('banner.noProvider')}</p>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="h-8 flex-shrink-0"
            >
              <Link href={`/${locale}/resources?tab=providers`}>
                {t('banner.noProviderCta')}
              </Link>
            </Button>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card) => {
            const Icon = card.icon;
            const droppable = Boolean(card.slug);
            return (
              <Link
                key={card.key}
                href={cardTarget(card)}
                className={cn(
                  'group relative rounded-xl border bg-card p-4 transition-all hover:shadow-md hover:-translate-y-0.5',
                  dragCard === card.key &&
                    'border-2 border-dashed border-primary bg-muted/50',
                )}
                onDragOver={
                  droppable
                    ? (e) => {
                        e.preventDefault();
                        setDragCard(card.key);
                      }
                    : undefined
                }
                onDragLeave={
                  droppable
                    ? (e) => {
                        e.preventDefault();
                        setDragCard(null);
                      }
                    : undefined
                }
                onDrop={droppable ? (e) => handleCardDrop(e, card) : undefined}
              >
                {card.needsModel && !hasModels && (
                  <Badge
                    variant="outline"
                    className="absolute right-3 top-3 text-[10px] px-1.5 py-0 border-amber-500/40 text-amber-600 dark:text-amber-400"
                  >
                    {t('needsModelBadge')}
                  </Badge>
                )}
                <div
                  className={cn(
                    'mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg',
                    card.chip,
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="text-sm font-semibold">
                  {dragCard === card.key
                    ? t('dropHint')
                    : t(`card.${card.key}`)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  {t(`card.${card.key}Desc`)}
                </p>
              </Link>
            );
          })}
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {t('recentTasks')}
          </h2>
          {recentFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground/70">
              {t('noRecentTasks')}
            </p>
          ) : (
            <div className="rounded-xl border divide-y">
              {recentFiles.map((file) => {
                const status = getRecentStatus(
                  file,
                  currentTypeDef,
                  userConfig,
                );
                return (
                  <Link
                    key={file?.uuid}
                    href={`/${locale}/tasks/${currentTypeDef.slug}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors"
                  >
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full flex-shrink-0',
                        STATUS_DOT[status],
                      )}
                    />
                    <span className="truncate text-sm min-w-0 flex-1">
                      {file?.fileName}
                      {file?.fileExtension}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {t(`status.${status}`)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'launchpad']);

export { getStaticPaths };
