import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { GlossaryEntry } from '../../../types/glossary';

export default function GlossaryEntryDialog({
  open,
  entry,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  entry: GlossaryEntry | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (value: { source: string; target: string; note: string }) => void;
}) {
  const { t } = useTranslation('glossary');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setSource(entry?.source || '');
    setTarget(entry?.target || '');
    setNote(entry?.note || '');
  }, [entry, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {entry ? t('entryDialog.editTitle') : t('entryDialog.addTitle')}
          </DialogTitle>
          <DialogDescription>{t('entryDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label htmlFor="glossary-source" className="text-sm font-medium">
              {t('fields.source')}
            </label>
            <Input
              id="glossary-source"
              value={source}
              maxLength={300}
              autoFocus
              onChange={(event) => setSource(event.target.value)}
              placeholder={t('entryDialog.sourcePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="glossary-target" className="text-sm font-medium">
              {t('fields.target')}
            </label>
            <Input
              id="glossary-target"
              value={target}
              maxLength={600}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={t('entryDialog.targetPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="glossary-note" className="text-sm font-medium">
              {t('fields.note')}
            </label>
            <Textarea
              id="glossary-note"
              value={note}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t('entryDialog.notePlaceholder')}
              className="min-h-[88px] resize-y"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!source.trim() || !target.trim() || saving}
            onClick={() => onSave({ source, target, note })}
          >
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
