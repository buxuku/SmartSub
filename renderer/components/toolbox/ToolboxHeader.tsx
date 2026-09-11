import React from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { ChevronLeft, Boxes } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getToolManifest } from './registry';
import type { ToolboxToolId } from '../../../types/toolbox';

interface ToolboxHeaderProps {
  activeToolId?: ToolboxToolId | null;
  onBack?: () => void;
}

export default function ToolboxHeader({
  activeToolId,
  onBack,
}: ToolboxHeaderProps) {
  const { t } = useTranslation('toolbox');
  const manifest = activeToolId ? getToolManifest(activeToolId) : null;

  return (
    <div className="flex items-center justify-between border-b border-border bg-background/95 px-6 py-3.5 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex items-center gap-3">
        {activeToolId ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="h-8 gap-1 px-2.5 text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>{t('backToDashboard')}</span>
            </Button>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              {manifest && (
                <manifest.iconComponent className="h-4 w-4 text-primary" />
              )}
              <h1 className="text-sm font-semibold tracking-tight text-foreground">
                {manifest ? t(manifest.nameKey) : t('title')}
              </h1>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Boxes className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-foreground">
                {t('title')}
              </h1>
              <p className="text-xs text-muted-foreground">
                {t('subtitle')}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
