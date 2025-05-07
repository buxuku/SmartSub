import React, { FC } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'next-i18next';

interface IProps {
  loading?: boolean;
  progress?: number;
  handleDownModel?: (source: string) => void;
  setShowGuide?: (type: boolean) => void;
}

const DownModelDropdown: FC<IProps> = ({
  loading,
  progress,
  handleDownModel,
  setShowGuide,
}) => {
  const { t } = useTranslation('common');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={loading} className="w-24">
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {loading ? `${(progress * 100).toFixed(2)}%` : t('download')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[225px]">
        <DropdownMenuLabel>{t('pleaseSelectSource')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer hover:bg-gray-100"
          onClick={() => handleDownModel('hf-mirror')}
        >
          {t('domesticMirrorSource')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer hover:bg-gray-100"
          onClick={() => handleDownModel('huggingface')}
        >
          {t('officialHuggingFaceSource')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer hover:bg-gray-100"
          onClick={() => setShowGuide(false)}
        >
          {t('downloadLater')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default DownModelDropdown;
