import React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelHeader } from '@/components/ui/panel';
import { cn } from 'lib/utils';
import { Check } from 'lucide-react';

export interface EnvRow {
  key: string;
  label: string;
  ready: boolean;
  /** 就绪时的值文案（如引擎名 / 已配置数量） */
  value: string;
  /** 行尾动作文案（管理 / 去配置） */
  action: string;
  href: string;
}

/**
 * 启动台右栏「环境就绪度」：把模型 / GPU / 翻译 / 配音四类分散状态
 * 聚合成常显仪表，未配置项直接给入口（统一引导动线的一部分）。
 */
export default function EnvReadiness({
  title,
  readyBadge,
  rows,
}: {
  title: string;
  readyBadge: string | null;
  rows: EnvRow[];
}) {
  return (
    <Panel>
      <PanelHeader
        title={title}
        actions={
          readyBadge ? (
            <Badge className="border-transparent bg-success/10 text-success">
              <Check className="h-3 w-3" />
              {readyBadge}
            </Badge>
          ) : null
        }
      />
      <div className="py-1">
        {rows.map((row) => (
          <Link
            key={row.key}
            href={row.href}
            className="group flex h-[34px] items-center gap-2 px-3 text-[12.5px] transition-colors hover:bg-accent/60"
          >
            <span className="w-16 flex-none text-muted-foreground">
              {row.label}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 font-medium">
              <span
                className={cn(
                  'h-[7px] w-[7px] flex-none rounded-full',
                  row.ready
                    ? 'bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.15)]'
                    : 'bg-faint/50',
                )}
              />
              <span className="truncate">{row.value}</span>
            </span>
            <span className="flex flex-none items-center gap-0.5 text-[11.5px] text-primary opacity-80 transition-opacity group-hover:opacity-100">
              {row.action}
              <ChevronRight className="h-3 w-3" />
            </span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}
