import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  CheckCircle,
  ExternalLink,
  FileCode,
  FolderOpen,
  Info,
  X,
} from 'lucide-react';
import { openUrl } from '@/lib/utils';

interface GpuCustomAddonSectionProps {
  customAddonPath: string | null;
  onSelectCustomAddon: () => void;
  onClearCustomAddon: () => void;
}

const GpuCustomAddonSection: React.FC<GpuCustomAddonSectionProps> = ({
  customAddonPath,
  onSelectCustomAddon,
  onClearCustomAddon,
}) => {
  const { t } = useTranslation('settings');

  return (
    <div className="pt-3 border-t border-dashed space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileCode className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            {t('gpuAcceleration.customAddonPath')}
          </span>
        </div>
        <button
          type="button"
          onClick={() =>
            openUrl('https://github.com/buxuku/whisper.cpp/releases/tag/latest')
          }
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer"
        >
          <ExternalLink className="w-3 h-3" />
          {t('gpuAcceleration.downloadPackageUrl')}
        </button>
      </div>
      <div className="flex items-start gap-2 p-2.5 bg-muted/50 rounded-md">
        <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <div className="text-[11px] text-muted-foreground space-y-1">
          <p>{t('gpuAcceleration.customAddonTip')}</p>
          <p>{t('gpuAcceleration.customAddonDllTip')}</p>
        </div>
      </div>
      {customAddonPath ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 p-2.5 rounded-lg border-2 border-primary bg-primary/5">
            <CheckCircle className="w-4 h-4 text-success shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">
                {t('gpuAcceleration.customAddonActive')}
              </div>
              <div
                className="text-[11px] text-muted-foreground truncate"
                title={customAddonPath}
              >
                {customAddonPath}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={onSelectCustomAddon}
              >
                <FolderOpen className="w-3.5 h-3.5 mr-1" />
                {t('gpuAcceleration.selectAddonFile')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-destructive"
                onClick={onClearCustomAddon}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t('gpuAcceleration.customAddonSwitchHint')}
          </p>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-full h-9 text-xs"
          onClick={onSelectCustomAddon}
        >
          <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
          {t('gpuAcceleration.selectAddonFile')}
        </Button>
      )}
    </div>
  );
};

export default GpuCustomAddonSection;
