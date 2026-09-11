import React, { useState, useMemo } from 'react';
import { useTranslation } from 'next-i18next';
import { Search, ArrowRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { TOOL_REGISTRY, type ToolRegistryItem } from './registry';
import type { ToolCategory, ToolboxToolId } from '../../../types/toolbox';
import { cn } from 'lib/utils';

interface ToolboxDashboardProps {
  onSelectTool: (toolId: ToolboxToolId) => void;
}

const CATEGORIES: Array<{ key: ToolCategory; labelKey: string }> = [
  { key: 'all', labelKey: 'categories.all' },
  { key: 'subtitles', labelKey: 'categories.subtitles' },
  { key: 'video', labelKey: 'categories.video' },
  { key: 'audio', labelKey: 'categories.audio' },
];

export default function ToolboxDashboard({ onSelectTool }: ToolboxDashboardProps) {
  const { t } = useTranslation('toolbox');
  const [selectedCategory, setSelectedCategory] = useState<ToolCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTools = useMemo(() => {
    return TOOL_REGISTRY.filter((tool) => {
      if (selectedCategory !== 'all' && tool.category !== selectedCategory) {
        return false;
      }
      if (!searchQuery.trim()) return true;

      const q = searchQuery.toLowerCase().trim();
      const name = t(tool.nameKey).toLowerCase();
      const desc = t(tool.descKey).toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [selectedCategory, searchQuery, t]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      {/* 顶部搜索与分类过滤 */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* 分类 Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/60 p-1">
          {CATEGORIES.map((cat) => {
            const active = selectedCategory === cat.key;
            return (
              <button
                key={cat.key}
                type="button"
                onClick={() => setSelectedCategory(cat.key)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(cat.labelKey)}
              </button>
            );
          })}
        </div>

        {/* 搜索框 */}
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t('searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 pl-8 text-xs"
          />
        </div>
      </div>

      {/* 工具卡片列表 */}
      {filteredTools.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          <p className="text-sm">{t('noToolsFound')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredTools.map((tool) => {
            const Icon = tool.iconComponent;
            return (
              <div
                key={tool.id}
                onClick={() => onSelectTool(tool.id)}
                className="group relative flex flex-col justify-between overflow-hidden rounded-xl border border-border bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md cursor-pointer"
              >
                <div>
                  <div className="mb-3.5 flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon className="h-5 w-5" />
                    </div>
                    {tool.badgeKey && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] font-normal px-2 py-0.5 bg-primary/10 text-primary border-transparent"
                      >
                        {t(tool.badgeKey)}
                      </Badge>
                    )}
                  </div>

                  <h3 className="text-sm font-medium tracking-tight text-foreground transition-colors group-hover:text-primary">
                    {t(tool.nameKey)}
                  </h3>

                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {t(tool.descKey)}
                  </p>
                </div>

                <div className="mt-4 flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-1">
                  <span>进入工具</span>
                  <ArrowRight className="h-3 w-3" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
