import { useEffect, useMemo, useState } from 'react';
import type { CustomLanguage } from '../../types/language';
import { sanitizeCustomLanguages } from '../../types/language';
import { supportedLanguage } from '../lib/utils';

const builtInCodes = supportedLanguage.map((language) => language.value);

/**
 * Load user-defined languages from the shared settings store.
 *
 * Settings and task pages are separate routes, so loading on mount is enough
 * to reflect changes made in Settings without introducing another global
 * client-side store.
 */
export function useCustomLanguages(): CustomLanguage[] {
  const [languages, setLanguages] = useState<CustomLanguage[]>([]);

  useEffect(() => {
    let mounted = true;
    window?.ipc
      ?.invoke('getSettings')
      .then((settings) => {
        if (!mounted) return;
        setLanguages(
          sanitizeCustomLanguages(settings?.customLanguages, builtInCodes),
        );
      })
      .catch(() => {
        if (mounted) setLanguages([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return useMemo(() => languages, [languages]);
}
