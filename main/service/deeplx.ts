import axios from 'axios';

const LANGUAGE_MAP: Record<string, string> = {
  zh: 'ZH',
  'zh-cn': 'ZH',
  'zh-hans': 'ZH',
  'zh-hant': 'ZH',
  'zh-tw': 'ZH',
  ja: 'JA',
  jp: 'JA',
  en: 'EN',
};

function normalizeDeepLXLanguage(language?: string): string {
  if (!language) return '';
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_MAP[normalized] || normalized.toUpperCase();
}

export default async function deeplx(
  query,
  proof,
  sourceLanguage = 'ja',
  targetLanguage = 'zh',
) {
  const { apiUrl } = proof || {};
  try {
    const res = await axios.post(apiUrl, {
      text: query?.join('\n'),
      source_lang: normalizeDeepLXLanguage(sourceLanguage),
      target_lang: normalizeDeepLXLanguage(targetLanguage),
    });
    return res?.data?.alternatives?.[0] || '';
  } catch (error) {
    console.log(error, 'error');
    throw error;
  }
}
