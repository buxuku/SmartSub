import React from 'react';
import { UploadCloud } from 'lucide-react';
import { useTranslation } from 'next-i18next';

interface GlobalDropOverlayProps {
  isDragging: boolean;
}

export default function GlobalDropOverlay({
  isDragging,
}: GlobalDropOverlayProps) {
  const { t } = useTranslation('launchpad');

  if (!isDragging) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm transition-all duration-200">
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-primary/5 p-8 text-center shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UploadCloud className="h-8 w-8 animate-bounce" />
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-foreground">
            {t('globalDrop.title')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('globalDrop.desc')}
          </p>
        </div>
      </div>
    </div>
  );
}
