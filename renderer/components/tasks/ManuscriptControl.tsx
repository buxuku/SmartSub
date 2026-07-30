import React, { useState } from 'react';
import { FileText, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTranslation } from 'next-i18next';

interface ManuscriptControlProps {
  form: any;
  formData: any;
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
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {t('manuscript.label')}
      </span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 max-w-[210px] gap-1.5 px-2 text-xs"
              onClick={selectManuscript}
              disabled={selecting}
            >
              {selecting ? (
                <Loader2 className="h-3.5 w-3.5 flex-none animate-spin" />
              ) : (
                <FileText className="h-3.5 w-3.5 flex-none" />
              )}
              <span className="truncate">
                {manuscriptName || t('manuscript.select')}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[360px]">
            {manuscriptPath || t('manuscript.hint')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {manuscriptPath && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 flex-none text-muted-foreground hover:text-destructive"
          aria-label={t('manuscript.clear')}
          title={t('manuscript.clear')}
          onClick={clearManuscript}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
};

export default ManuscriptControl;
