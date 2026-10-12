import React, { useState } from 'react';
import { Check, FileText, Slash, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IFiles } from '../../../types';
import { cn } from 'lib/utils';

interface ManuscriptRowBadgeProps {
  file: IFiles;
  formData?: any;
  disabled?: boolean;
  compact?: boolean;
  manuscriptPool?: IFiles[];
  onAssignManuscript?: (
    file: IFiles,
    manuscriptPath: string,
    manuscriptName?: string,
  ) => void;
}

/** Pills of a compact (grid) badge give way to the meta text beside them. */
const pillSize = (compact: boolean) =>
  compact ? 'min-w-0 max-w-[130px]' : 'max-w-[180px] flex-shrink-0';

/**
 * The "+ reference script" chip. In a grid card it is always laid out and only
 * fades in on hover, keyboard focus or while its menu is open, so hovering a
 * card never changes its height (display:none <-> inline-flex did).
 */
const addChipClass = (compact: boolean) =>
  cn(
    'inline-flex flex-shrink-0 cursor-pointer items-center whitespace-nowrap rounded border border-dashed border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
    compact
      ? 'opacity-0 transition-[opacity,color,border-color] group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100'
      : 'transition-colors',
  );

export const ManuscriptRowBadge: React.FC<ManuscriptRowBadgeProps> = ({
  file,
  formData,
  disabled = false,
  compact = false,
  manuscriptPool,
  onAssignManuscript,
}) => {
  const { t } = useTranslation('tasks');
  const [selecting, setSelecting] = useState(false);

  const hasSpecific = Boolean(
    file.manuscriptPath && file.manuscriptPath !== '__none__',
  );
  const isSkipped = file.manuscriptPath === '__none__';
  const hasGlobal = Boolean(!file.manuscriptPath && formData?.manuscriptPath);

  const handlePickScript = async () => {
    if (disabled || selecting) return;
    setSelecting(true);
    try {
      const result = (await window?.ipc?.invoke('manuscript:select')) as {
        path?: string;
        name?: string;
        errorCode?: string;
        error?: string;
      } | null;
      if (!result) return;
      if (result.errorCode || !result.path) {
        toast.error(
          t(`manuscript.error.${result.errorCode || 'unreadable'}`, {
            defaultValue: result.error || t('manuscript.error.unreadable'),
          }),
        );
        return;
      }
      onAssignManuscript?.(file, result.path, result.name);
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

  const handleUnlink = () => {
    onAssignManuscript?.(file, '');
  };

  const handleSkip = () => {
    onAssignManuscript?.(file, '__none__');
  };

  const renderPoolItems = () => {
    if (!manuscriptPool || manuscriptPool.length === 0) return null;
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          {t('manuscript.poolLabel')}
        </DropdownMenuLabel>
        {manuscriptPool.map((s) => {
          const displayName = s.filePath.split(/[\\/]/).pop() || s.fileName;
          const isCurrent = file.manuscriptPath === s.filePath;
          return (
            <DropdownMenuItem
              key={s.filePath}
              disabled={disabled}
              onClick={() => onAssignManuscript?.(file, s.filePath, s.fileName)}
              className="flex items-center justify-between"
            >
              <span className="truncate max-w-[200px]" title={s.filePath}>
                {displayName}
              </span>
              {isCurrent && (
                <Check className="h-3.5 w-3.5 text-primary ml-2 flex-none" />
              )}
            </DropdownMenuItem>
          );
        })}
      </>
    );
  };

  // 1. 专属文稿
  if (hasSpecific) {
    const displayName =
      file.manuscriptName || file.manuscriptPath!.split(/[\\/]/).pop() || '';

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex cursor-pointer items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20',
              pillSize(compact),
            )}
            title={file.manuscriptPath}
          >
            <FileText className="h-3 w-3 flex-none" />
            <span className="truncate">
              {t('manuscript.tagSpecific', { name: displayName })}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56 max-w-[320px] max-h-[360px] overflow-y-auto"
        >
          <DropdownMenuItem onClick={handlePickScript} disabled={disabled}>
            <FileText className="mr-2 h-3.5 w-3.5" />
            {t('manuscript.browseLocal')}
          </DropdownMenuItem>
          {renderPoolItems()}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleUnlink} disabled={disabled}>
            {formData?.manuscriptPath ? (
              <>
                <Undo2 className="mr-2 h-3.5 w-3.5" />
                {t('manuscript.tagGlobal', {
                  name:
                    formData.manuscriptName ||
                    formData.manuscriptPath.split(/[\\/]/).pop() ||
                    '',
                })}
              </>
            ) : (
              <>
                <X className="mr-2 h-3.5 w-3.5" />
                {t('manuscript.unlinkScript')}
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleSkip}
            disabled={disabled}
            className="text-muted-foreground"
          >
            <Slash className="mr-2 h-3.5 w-3.5" />
            {t('manuscript.skipScript')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // 2. 显式跳过
  if (isSkipped) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex cursor-pointer items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted',
              compact ? 'min-w-0 max-w-[130px]' : 'flex-shrink-0',
            )}
          >
            <Slash className="h-3 w-3 flex-none" />
            <span className="truncate">{t('manuscript.skipScript')}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56 max-w-[320px] max-h-[360px] overflow-y-auto"
        >
          <DropdownMenuItem onClick={handlePickScript} disabled={disabled}>
            <FileText className="mr-2 h-3.5 w-3.5" />
            {t('manuscript.browseLocal')}
          </DropdownMenuItem>
          {renderPoolItems()}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleUnlink} disabled={disabled}>
            <Undo2 className="mr-2 h-3.5 w-3.5" />
            {formData?.manuscriptPath
              ? t('manuscript.tagGlobal', {
                  name:
                    formData.manuscriptName ||
                    formData.manuscriptPath.split(/[\\/]/).pop() ||
                    '',
                })
              : t('manuscript.unlinkScript')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // 3. 继承全局文稿
  if (hasGlobal) {
    const displayName =
      formData.manuscriptName ||
      formData.manuscriptPath.split(/[\\/]/).pop() ||
      '';

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex cursor-pointer items-center gap-1 rounded border border-dashed border-primary/30 bg-muted/30 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted',
              pillSize(compact),
            )}
            title={formData.manuscriptPath}
          >
            <FileText className="h-3 w-3 flex-none opacity-60" />
            <span className="truncate">
              {t('manuscript.tagGlobal', { name: displayName })}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56 max-w-[320px] max-h-[360px] overflow-y-auto"
        >
          <DropdownMenuItem onClick={handlePickScript} disabled={disabled}>
            <FileText className="mr-2 h-3.5 w-3.5" />
            {t('manuscript.browseLocal')}
          </DropdownMenuItem>
          {renderPoolItems()}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleSkip}
            disabled={disabled}
            className="text-muted-foreground"
          >
            <Slash className="mr-2 h-3.5 w-3.5" />
            {t('manuscript.skipScript')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // 4. 无文稿且全局无文稿：队列空闲时提供轻量「+ 参考文稿」入口
  //    （网格卡片里它常驻布局、仅悬停时淡入，见 addChipClass）
  if (disabled) return null;

  if (manuscriptPool && manuscriptPool.length > 0) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={addChipClass(compact)}
            title={t('manuscript.addScript')}
          >
            {t('manuscript.addScript')}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56 max-w-[320px] max-h-[360px] overflow-y-auto"
        >
          <DropdownMenuItem onClick={handlePickScript} disabled={disabled}>
            <FileText className="mr-2 h-3.5 w-3.5" />
            {t('manuscript.browseLocal')}
          </DropdownMenuItem>
          {renderPoolItems()}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleSkip}
            disabled={disabled}
            className="text-muted-foreground"
          >
            <Slash className="mr-2 h-3.5 w-3.5" />
            {t('manuscript.skipScript')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <button
      type="button"
      onClick={handlePickScript}
      className={addChipClass(compact)}
      title={t('manuscript.addScript')}
    >
      {t('manuscript.addScript')}
    </button>
  );
};

export default ManuscriptRowBadge;
