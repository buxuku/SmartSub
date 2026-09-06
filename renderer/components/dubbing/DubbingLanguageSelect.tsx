import React from 'react';
import { useTranslation } from 'next-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCustomLanguages } from '../../hooks/useCustomLanguages';
import { supportedLanguage } from '../../lib/utils';
import { mergeLanguageOptions } from '../../../types/language';

export default function DubbingLanguageSelect({
  value,
  onChange,
  resolved,
  disabled,
}: {
  value?: string;
  onChange: (language: string) => void;
  resolved?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('common');
  const custom = useCustomLanguages();
  const options = mergeLanguageOptions(supportedLanguage, custom);
  const current = value || 'auto';
  return (
    <Select value={current} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="min-w-0 w-full" aria-label={t('ttsLanguage')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">
          {resolved
            ? t('ttsLanguageResolved', { language: resolved })
            : t('ttsLanguageAuto')}
        </SelectItem>
        {current !== 'auto' && !options.some((o) => o.value === current) && (
          <SelectItem value={current}>{current}</SelectItem>
        )}
        {options
          .filter((o) => o.value !== 'auto')
          .map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.isCustom ? `${o.name} (${o.value})` : t(`language.${o.value}`)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
