/**
 * 语言代码检测器
 * 从文件名中自动检测语言代码
 */

import path from 'path';
import { LanguageDetectionResult } from '../../types/proofread';

// ISO 639-1 语言代码映射表
const LANGUAGE_MAP: Record<string, string> = {
  // 常用语言
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
  pt: '葡萄牙语',
  it: '意大利语',

  // 其他欧洲语言
  nl: '荷兰语',
  pl: '波兰语',
  tr: '土耳其语',
  sv: '瑞典语',
  cs: '捷克语',
  da: '丹麦语',
  fi: '芬兰语',
  el: '希腊语',
  hu: '匈牙利语',
  no: '挪威语',
  ro: '罗马尼亚语',
  sk: '斯洛伐克语',
  hr: '克罗地亚语',
  sr: '塞尔维亚语',
  sl: '斯洛文尼亚语',
  bg: '保加利亚语',
  uk: '乌克兰语',
  et: '爱沙尼亚语',
  lv: '拉脱维亚语',
  lt: '立陶宛语',

  // 亚洲语言
  hi: '印地语',
  th: '泰语',
  vi: '越南语',
  id: '印度尼西亚语',
  ms: '马来语',
  ta: '泰米尔语',
  ur: '乌尔都语',
  mr: '马拉地语',

  // 中东语言
  ar: '阿拉伯语',
  he: '希伯来语',
  fa: '波斯语',

  // 其他语言
  af: '阿非利堪斯语',
  ca: '加泰罗尼亚语',
  gl: '加利西亚语',
  tl: '塔加洛语',
  sw: '斯瓦希里语',
  cy: '威尔士语',
  mn: '蒙古语',
};

// 语言代码别名映射（常见变体）
const LANGUAGE_ALIASES: Record<string, string> = {
  // 中文变体
  'zh-cn': 'zh',
  'zh-tw': 'zh',
  'zh-hk': 'zh',
  'zh-hans': 'zh',
  'zh-hant': 'zh',
  chs: 'zh',
  cht: 'zh',
  chi: 'zh',
  chinese: 'zh',
  cn: 'zh',

  // 英语变体
  'en-us': 'en',
  'en-gb': 'en',
  'en-au': 'en',
  eng: 'en',
  english: 'en',

  // 日语变体
  jpn: 'ja',
  jap: 'ja',
  japanese: 'ja',
  jp: 'ja',

  // 韩语变体
  kor: 'ko',
  korean: 'ko',
  kr: 'ko',

  // 法语变体
  fra: 'fr',
  fre: 'fr',
  french: 'fr',

  // 德语变体
  ger: 'de',
  deu: 'de',
  german: 'de',

  // 西班牙语变体
  spa: 'es',
  spanish: 'es',

  // 俄语变体
  rus: 'ru',
  russian: 'ru',

  // 葡萄牙语变体
  por: 'pt',
  'pt-br': 'pt',
  portuguese: 'pt',

  // 意大利语变体
  ita: 'it',
  italian: 'it',
};

// 文件名中常见的语言标记模式
const LANGUAGE_PATTERNS = [
  // 标准后缀格式：video.en.srt, video.zh-CN.srt
  /\.([a-z]{2}(?:-[a-z]{2,4})?)\.(?:srt|vtt|ass|ssa)$/i,
  // 下划线格式：video_en.srt, video_chinese.srt
  /_([a-z]{2,10})\.(?:srt|vtt|ass|ssa)$/i,
  // 方括号格式：video[en].srt, video[chinese].srt
  /\[([a-z]{2,10})\]\.(?:srt|vtt|ass|ssa)$/i,
  // 括号格式：video(en).srt, video(chinese).srt
  /\(([a-z]{2,10})\)\.(?:srt|vtt|ass|ssa)$/i,
  // 点分隔但在扩展名之前：video.english.srt
  /\.([a-z]{2,10})\.(?:srt|vtt|ass|ssa)$/i,
];

/**
 * 从文件名检测语言
 */
export function detectLanguageFromFilename(
  filePath: string,
): LanguageDetectionResult | null {
  const fileName = path.basename(filePath).toLowerCase();

  for (const pattern of LANGUAGE_PATTERNS) {
    const match = fileName.match(pattern);
    if (match) {
      const detected = match[1].toLowerCase();
      const normalized = normalizeLanguageCode(detected);

      if (normalized && LANGUAGE_MAP[normalized]) {
        return {
          code: normalized,
          name: LANGUAGE_MAP[normalized],
          confidence: 90,
        };
      }
    }
  }

  return null;
}

/**
 * 标准化语言代码
 */
export function normalizeLanguageCode(code: string): string | null {
  const lower = code.toLowerCase();

  // 直接匹配 ISO 639-1 代码
  if (LANGUAGE_MAP[lower]) {
    return lower;
  }

  // 检查别名
  if (LANGUAGE_ALIASES[lower]) {
    return LANGUAGE_ALIASES[lower];
  }

  // 处理带区域的代码（如 zh-CN -> zh）
  const baseLang = lower.split('-')[0];
  if (LANGUAGE_MAP[baseLang]) {
    return baseLang;
  }

  return null;
}

/**
 * 获取语言名称
 */
export function getLanguageName(code: string): string {
  const normalized = normalizeLanguageCode(code);
  return normalized ? LANGUAGE_MAP[normalized] || code : code;
}

/**
 * 获取所有支持的语言列表
 */
export function getSupportedLanguages(): Array<{ code: string; name: string }> {
  return Object.entries(LANGUAGE_MAP).map(([code, name]) => ({
    code,
    name,
  }));
}

/**
 * 从多个字幕文件中检测语言对
 */
export function detectLanguagePair(subtitleFiles: string[]): {
  source?: string;
  target?: string;
} {
  const languages: Array<{ file: string; lang: LanguageDetectionResult }> = [];

  for (const file of subtitleFiles) {
    const detected = detectLanguageFromFilename(file);
    if (detected) {
      languages.push({ file, lang: detected });
    }
  }

  // 如果检测到两种不同的语言，尝试确定源语言和目标语言
  if (languages.length >= 2) {
    // 优先将英语作为源语言，中文作为目标语言
    const enIndex = languages.findIndex((l) => l.lang.code === 'en');
    const zhIndex = languages.findIndex((l) => l.lang.code === 'zh');

    if (enIndex >= 0 && zhIndex >= 0) {
      return {
        source: 'en',
        target: 'zh',
      };
    }

    // 否则按检测顺序，第一个作为源语言
    return {
      source: languages[0].lang.code,
      target: languages[1].lang.code,
    };
  }

  if (languages.length === 1) {
    return {
      source: languages[0].lang.code,
    };
  }

  return {};
}

/**
 * 验证语言代码是否有效
 */
export function isValidLanguageCode(code: string): boolean {
  return normalizeLanguageCode(code) !== null;
}
