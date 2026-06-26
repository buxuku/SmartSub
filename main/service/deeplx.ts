import axios from 'axios';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';

/**
 * 把应用内的语言代码（小写 ISO 639-1，如 zh/en/ja）转成 DeepL(X) 接受的代码（大写）。
 * 简体中文 -> ZH，繁体中文 -> ZH-HANT；其余直接大写。源语言缺省用 auto 让 DeepL 自动识别。
 */
function toDeepLCode(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  if (code === 'zh' || code === 'zh-Hans') return 'ZH';
  if (code === 'zh-Hant') return 'ZH-HANT';
  return code.toUpperCase();
}

export default async function deeplx(
  query,
  proof,
  sourceLanguage?: string,
  targetLanguage?: string,
) {
  const { apiUrl } = proof || {};
  if (!apiUrl) {
    throw new Error('missing configuration: DeepLX apiUrl');
  }
  const text = Array.isArray(query) ? query.join('\n') : String(query ?? '');
  try {
    const res = await axios.post(
      apiUrl,
      {
        text,
        source_lang: sourceLanguage
          ? toDeepLCode(sourceLanguage, 'auto')
          : 'auto',
        target_lang: toDeepLCode(targetLanguage, 'ZH'),
      },
      { timeout: TRANSLATION_REQUEST_TIMEOUT },
    );
    // DeepLX 标准响应主结果在 data 字段，alternatives 仅为备选且常为空；
    // 旧实现只读 alternatives[0]，当 DeepLX 不返回备选时就得到空串。优先取 data，回退 alternatives[0]。
    const body = res?.data ?? {};
    const translated =
      (typeof body.data === 'string' && body.data) ||
      body?.alternatives?.[0] ||
      '';
    return translated;
  } catch (error) {
    console.log(error, 'deeplx error');
    throw error;
  }
}
