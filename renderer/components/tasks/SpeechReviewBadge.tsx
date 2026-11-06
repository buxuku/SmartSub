import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import type { IFiles } from '../../../types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { speechRangeTime } from '../subtitle/MissedSpeechControls';

/** The review is automatic; expose its changes without adding decoding settings. */
export function SpeechReviewBadge({ file }: { file: IFiles }) {
  const { t } = useTranslation('tasks');
  const summary = file.speechReviewSummary;
  if (!summary) return null;
  if (summary.status === 'unavailable') {
    return (
      <span
        className="text-[10px] text-muted-foreground"
        title={t('speechReview.unavailableDetail')}
      >
        {t('speechReview.unavailable')}
      </span>
    );
  }
  if (!summary.recovered && !summary.retimed) return null;
  const label = summary.recovered
    ? t('row.speechRecovered', { count: summary.recovered })
    : t('speechReview.retimed', { count: summary.retimed });
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-[10px] underline underline-offset-2"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-w-xl whitespace-normal text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{t('speechReview.title')}</DialogTitle>
          <DialogDescription>
            {t(
              summary.recovered
                ? 'speechReview.description'
                : 'speechReview.timingDescription',
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto text-sm">
          {(summary.changes || []).map((change, index) => (
            <div key={index} className="space-y-1 rounded border p-3">
              <p className="text-xs text-muted-foreground">
                {speechRangeTime(change.start * 1000)} –{' '}
                {speechRangeTime(change.end * 1000)}
              </p>
              <p className="break-words text-muted-foreground">
                {t('speechReview.before')}
                {change.original.trim() || t('speechReview.empty')}
              </p>
              <p className="break-words">
                {t('speechReview.after')}
                {change.text.trim()}
              </p>
            </div>
          ))}
          {!!summary.retimed && (
            <p>{t('speechReview.retimed', { count: summary.retimed })}</p>
          )}
        </div>
        {file.speechReviewOriginalFile && (
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const response = await window.ipc.invoke(
                  'subtitleMerge:openOutputFolder',
                  { filePath: file.speechReviewOriginalFile },
                );
                if (response?.error || response?.success === false)
                  throw new Error('reveal failed');
              } catch {
                toast.error(t('speechReview.openFailed'));
              }
            }}
          >
            {t('speechReview.original')}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
