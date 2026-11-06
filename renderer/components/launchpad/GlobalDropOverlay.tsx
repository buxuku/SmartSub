import React from 'react';
import { Upload } from 'lucide-react';
import { useTranslation } from 'next-i18next';

interface GlobalDropOverlayProps {
  isDragging: boolean;
  recipeName?: string;
}

export default function GlobalDropOverlay({
  isDragging,
  recipeName,
}: GlobalDropOverlayProps) {
  const { t } = useTranslation('launchpad');

  if (!isDragging) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 border-2 border-primary shadow-[inset_0_0_0_4px_hsl(var(--primary)/0.08)]"
      role="status"
      aria-atomic="true"
    >
      <div className="absolute inset-x-3 bottom-3 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-start gap-2.5 rounded-md border border-primary/40 bg-card px-3 py-2.5 text-card-foreground shadow-lg">
        <Upload
          className="mt-0.5 h-4 w-4 flex-none text-primary"
          aria-hidden="true"
        />
        <div className="min-w-0 max-w-md break-words">
          <p className="text-[13px] font-semibold leading-5">
            {recipeName
              ? t('globalDrop.recipeTitle', { name: recipeName })
              : t('globalDrop.title')}
          </p>
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {t(recipeName ? 'globalDrop.recipeDesc' : 'globalDrop.desc')}
          </p>
        </div>
      </div>
    </div>
  );
}
