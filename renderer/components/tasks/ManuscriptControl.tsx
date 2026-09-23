import React, { useState } from 'react';
import { FileText, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';

interface ManuscriptControlProps {
  form: any;
  formData: any;
  className?: string;
}

interface ManuscriptSelection {
  path?: string;
  name?: string;
  errorCode?: string;
  error?: string;
}

const ManuscriptControl: React.FC<ManuscriptControlProps> = ({
  form,
  formData,
  className,
}) => {
  const { t } = useTranslation('tasks');
  const [selecting, setSelecting] = useState(false);
  const manuscriptPath =
    typeof formData?.manuscriptPath === 'string' ? formData.manuscriptPath : '';
  const manuscriptName =
    (typeof formData?.manuscriptName === 'string' && formData.manuscriptName) ||
    manuscriptPath.split(/[\\/]/).pop() ||
    '';

  const setValue = (name: string, value: unknown) =>
    form.setValue(name, value, { shouldDirty: true });

  const selectManuscript = async () => {
    if (selecting) return;
    setSelecting(true);
    try {
      const result = (await window?.ipc?.invoke(
        'manuscript:select',
      )) as ManuscriptSelection | null;
      if (!result) return;
      if (result.errorCode || !result.path) {
        const key = `manuscript.error.${result.errorCode || 'unreadable'}`;
        toast.error(
          t(key, {
            defaultValue: result.error || t('manuscript.error.unreadable'),
          }),
        );
        return;
      }
      setValue('manuscriptPath', result.path);
      setValue('manuscriptName', result.name || '');
      toast.success(
        t('manuscript.selected', {
          name: result.name || result.path,
        }),
      );
    } catch (error) {
      toast.error(
        t('manuscript.error.unreadable', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSelecting(false);
    }
  };

  const clearManuscript = () => {
    setValue('manuscriptPath', '');
    setValue('manuscriptName', '');
    toast.success(t('manuscript.cleared'));
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {t('manuscript.globalLabel')}
        </label>
        {manuscriptPath && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearManuscript}
            className="h-6 px-1.5 text-xs text-muted-foreground hover:text-destructive"
          >
            <X className="h-3.5 w-3.5 mr-1" />
            {t('manuscript.clear')}
          </Button>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t('manuscript.globalAdvancedHint')}
      </p>

      {manuscriptPath ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 p-2.5 text-xs">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <FileText className="h-4 w-4 flex-none text-primary" />
            <div className="min-w-0 flex-1">
              <div
                className="font-medium text-foreground truncate"
                title={manuscriptName}
              >
                {manuscriptName}
              </div>
              <div
                className="text-[11px] text-muted-foreground truncate"
                title={manuscriptPath}
              >
                {manuscriptPath}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={selectManuscript}
            disabled={selecting}
            className="h-7 px-2 text-xs flex-none"
          >
            {selecting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              t('manuscript.changeScript')
            )}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={selectManuscript}
          disabled={selecting}
          className="w-full justify-center text-xs h-9 gap-1.5 border-dashed"
        >
          {selecting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="h-3.5 w-3.5" />
          )}
          <span>{t('manuscript.select')}</span>
        </Button>
      )}
    </div>
  );
};

export default ManuscriptControl;
