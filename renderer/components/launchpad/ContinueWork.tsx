import React from 'react';
import { useRouter } from 'next/router';
import {
  Captions,
  Check,
  ChevronRight,
  Clapperboard,
  Languages,
  Mic,
  PenLine,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { cn } from 'lib/utils';
import { getTaskTypeByValue } from 'lib/taskTypes';
import {
  getFilePercent,
  getFileStages,
  getStageStatus,
} from '@/components/tasks/stageUtils';
import {
  getWorkItemStatus,
  getWorkItemTarget,
  getWorkItemTypeLabel,
} from 'lib/workItemUtils';
import type { WorkItem } from '../../../types/workItem';

type StageState = 'done' | 'active' | 'pending';

interface PipeStage {
  key: string;
  label: string;
  icon: LucideIcon;
  state: StageState;
}

/** 从最近任务中取「最新未完结」的一条：进行中优先，其次等待中 */
export function pickContinueItem(items: WorkItem[]): WorkItem | null {
  const sorted = items
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return (
    sorted.find((i) => getWorkItemStatus(i) === 'running') ??
    sorted.find((i) => getWorkItemStatus(i) === 'waiting') ??
    null
  );
}

/** 流水线工作项的整体进度（0-100，按文件均摊） */
function pipelinePercent(item: WorkItem): number {
  const typeDef = getTaskTypeByValue(item.type);
  const files = item.pipelineFiles || [];
  if (!typeDef || !files.length) return 0;
  let total = 0;
  for (const file of files) {
    total += getFilePercent(file, getFileStages(file, typeDef, undefined));
  }
  return Math.round(total / files.length);
}

/** 显性化「转写 → 翻译 → 校对 → 合成」流水线心智：按工作项推导各阶段状态 */
function deriveStages(item: WorkItem, t: (key: string) => string): PipeStage[] {
  const transcribe: PipeStage = {
    key: 'transcribe',
    label: t('pipeline.transcribe'),
    icon: Captions,
    state: 'pending',
  };
  const translate: PipeStage = {
    key: 'translate',
    label: t('pipeline.translate'),
    icon: Languages,
    state: 'pending',
  };
  const proofread: PipeStage = {
    key: 'proofread',
    label: t('pipeline.proofread'),
    icon: PenLine,
    state: 'pending',
  };
  const compose: PipeStage = {
    key: 'compose',
    label: t('pipeline.compose'),
    icon: Clapperboard,
    state: 'pending',
  };

  if (item.type === 'proofread') {
    proofread.state = item.status === 'done' ? 'done' : 'active';
    return [proofread, compose];
  }
  if (item.type === 'dubbing') {
    return [
      {
        key: 'dubbing',
        label: t('pipeline.dubbing'),
        icon: Mic,
        state: item.status === 'done' ? 'done' : 'active',
      },
    ];
  }

  const typeDef = getTaskTypeByValue(item.type);
  const files = item.pipelineFiles || [];
  const stageDone = (key: 'extractSubtitle' | 'translateSubtitle') =>
    files.length > 0 && files.every((f) => getStageStatus(f, key) === 'done');
  const stageActive = (key: 'extractSubtitle' | 'translateSubtitle') =>
    files.some((f) => getStageStatus(f, key) === 'loading');

  const stages: PipeStage[] = [];
  if (item.type !== 'translateOnly') {
    transcribe.state = stageDone('extractSubtitle')
      ? 'done'
      : stageActive('extractSubtitle') || files.length > 0
        ? 'active'
        : 'pending';
    stages.push(transcribe);
  }
  if (typeDef?.hasTranslate) {
    translate.state = stageDone('translateSubtitle')
      ? 'done'
      : stageActive('translateSubtitle')
        ? 'active'
        : 'pending';
    stages.push(translate);
  }
  stages.push(proofread, compose);
  return stages;
}

/**
 * 启动台右栏「继续上次的工作」：最新未完结任务 + 流水线阶段 + 接续入口。
 * 纯派生展示（数据源 = 既有最近任务），无新增存储。
 */
export default function ContinueWork({
  item,
  locale,
  t,
  tLaunchpad,
  tTasks,
  className,
}: {
  item: WorkItem;
  locale: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  tLaunchpad: (key: string, options?: Record<string, unknown>) => string;
  tTasks: (key: string) => string;
  className?: string;
}) {
  const router = useRouter();
  const status = getWorkItemStatus(item);
  const stages = deriveStages(item, t);
  const isPipeline =
    item.type === 'generateAndTranslate' ||
    item.type === 'generateOnly' ||
    item.type === 'translateOnly';
  const percent = isPipeline ? pipelinePercent(item) : null;

  return (
    <Panel className={className}>
      <PanelHeader title={t('continueWork.title')} />
      <div className="flex flex-col gap-2 px-3 pt-2.5">
        <p className="truncate text-[13px] font-semibold">{item.name}</p>
        <p className="text-[11.5px] text-muted-foreground">
          {getWorkItemTypeLabel(item, tLaunchpad, tTasks)}
          {' · '}
          {tLaunchpad(`status.${status}`)}
        </p>
        {percent !== null && (
          <Progress
            value={percent}
            className="h-1"
            aria-label={`${percent}%`}
          />
        )}
      </div>
      <div className="flex items-center gap-1 px-3 py-2.5">
        {stages.map((stage, i) => {
          const Icon = stage.state === 'done' ? Check : stage.icon;
          return (
            <React.Fragment key={stage.key}>
              {i > 0 && (
                <ChevronRight className="h-3 w-3 flex-none text-faint/60" />
              )}
              <div
                className={cn(
                  'flex min-w-0 flex-1 flex-col items-center gap-1 rounded-md border px-1 py-1.5 text-[10.5px]',
                  stage.state === 'done' &&
                    'border-success/25 bg-success/[0.06] text-success',
                  stage.state === 'active' &&
                    'border-primary/30 bg-primary/[0.07] text-primary',
                  stage.state === 'pending' &&
                    'border-border bg-panel-2 text-faint',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="truncate">{stage.label}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
      <div className="flex gap-2 px-3 pb-3">
        <Button
          className="flex-1"
          onClick={() => router.push(getWorkItemTarget(item, locale))}
        >
          {t('continueWork.resume')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => router.push(`/${locale}/recent-tasks`)}
        >
          {t('continueWork.queue')}
        </Button>
      </div>
    </Panel>
  );
}
