import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const models = [
  {
    name: 'tiny',
    size: '75 MB',
    needsCoreML: true,
  },
  {
    name: 'tiny-q5_1',
    size: '32.2 MB',
    needsCoreML: false,
  },
  {
    name: 'tiny-q8_0',
    size: '43.5 MB',
    needsCoreML: false,
  },
  {
    name: 'tiny.en',
    size: '77.7 MB',
    needsCoreML: true,
  },
  {
    name: 'tiny.en-q5_1',
    size: '32.2 MB',
    needsCoreML: false,
  },
  {
    name: 'tiny.en-q8_0',
    size: '43.6 MB',
    needsCoreML: false,
  },
  {
    name: 'base',
    size: '148 MB',
    needsCoreML: true,
  },
  {
    name: 'base-q5_1',
    size: '59.7 MB',
    needsCoreML: false,
  },
  {
    name: 'base-q8_0',
    size: '81.8 MB',
    needsCoreML: false,
  },
  {
    name: 'base.en',
    size: '148 MB',
    needsCoreML: true,
  },
  {
    name: 'base.en-q5_1',
    size: '59.7 MB',
    needsCoreML: false,
  },
  {
    name: 'base.en-q8_0',
    size: '81.8 MB',
    needsCoreML: false,
  },
  {
    name: 'small',
    size: '488 MB',
    needsCoreML: true,
  },
  {
    name: 'small-q5_1',
    size: '190 MB',
    needsCoreML: false,
  },
  {
    name: 'small-q8_0',
    size: '264 MB',
    needsCoreML: false,
  },
  {
    name: 'small.en',
    size: '488 MB',
    needsCoreML: true,
  },
  {
    name: 'small.en-q5_1',
    size: '190 MB',
    needsCoreML: false,
  },
  {
    name: 'small.en-q8_0',
    size: '264 MB',
    needsCoreML: false,
  },
  {
    name: 'medium',
    size: '1.53 GB',
    needsCoreML: true,
  },
  {
    name: 'medium-q5_0',
    size: '539 MB',
    needsCoreML: false,
  },
  {
    name: 'medium-q8_0',
    size: '823 MB',
    needsCoreML: false,
  },
  {
    name: 'medium.en',
    size: '1.53 GB',
    needsCoreML: true,
  },
  {
    name: 'medium.en-q5_0',
    size: '539 MB',
    needsCoreML: false,
  },
  {
    name: 'medium.en-q8_0',
    size: '823 MB',
    needsCoreML: false,
  },
  {
    name: 'large-v1',
    size: '3.09 GB',
    needsCoreML: true,
  },
  {
    name: 'large-v2',
    size: '3.09 GB',
    needsCoreML: true,
  },
  {
    name: 'large-v2-q5_0',
    size: '1.08 GB',
    needsCoreML: false,
  },
  {
    name: 'large-v2-q8_0',
    size: '1.66 GB',
    needsCoreML: false,
  },
  {
    name: 'large-v3',
    size: '3.1 GB',
    needsCoreML: true,
  },
  {
    name: 'large-v3-q5_0',
    size: '1.08 GB',
    needsCoreML: false,
  },
  {
    name: 'large-v3-turbo',
    size: '1.62 GB',
    needsCoreML: true,
  },
  {
    name: 'large-v3-turbo-q5_0',
    size: '574 MB',
    needsCoreML: false,
  },
  {
    name: 'large-v3-turbo-q8_0',
    size: '874 MB',
    needsCoreML: false,
  },
];

export const needsCoreML = (model: string) => {
  const modelInfo = models.find((m) => m.name === model);
  return modelInfo ? modelInfo.needsCoreML : false;
};

/**
 * 支持的语言列表（前端使用）
 * 优化结构：默认使用 value 作为各平台的语言代码
 * 只有当某平台的代码与 value 不同时才显式定义，不支持则定义为 null
 */
export const supportedLanguage = [
  // 最常用语言
  { name: '中文', value: 'zh' },
  { name: '英语', value: 'en' },
  { name: '日语', value: 'ja', baidu: 'jp' },
  { name: '韩语', value: 'ko', baidu: 'kor' },
  { name: '法语', value: 'fr', baidu: 'fra' },
  { name: '德语', value: 'de' },
  { name: '西班牙语', value: 'es', baidu: 'spa' },
  { name: '俄语', value: 'ru' },
  { name: '葡萄牙语', value: 'pt' },
  { name: '意大利语', value: 'it' },

  // 其他欧洲语言
  { name: '荷兰语', value: 'nl' },
  { name: '波兰语', value: 'pl' },
  { name: '土耳其语', value: 'tr', baidu: null },
  { name: '瑞典语', value: 'sv', baidu: 'swe' },
  { name: '捷克语', value: 'cs' },
  { name: '丹麦语', value: 'da', baidu: 'dan' },
  { name: '芬兰语', value: 'fi', baidu: 'fin' },
  { name: '希腊语', value: 'el' },
  { name: '匈牙利语', value: 'hu' },
  { name: '挪威语', value: 'no', baidu: null },
  { name: '罗马尼亚语', value: 'ro', baidu: 'rom' },
  { name: '斯洛伐克语', value: 'sk', baidu: null },
  { name: '克罗地亚语', value: 'hr', baidu: null },
  { name: '塞尔维亚语', value: 'sr', baidu: null },
  { name: '斯洛文尼亚语', value: 'sl', baidu: 'slo' },
  { name: '保加利亚语', value: 'bg', baidu: 'bul' },
  { name: '乌克兰语', value: 'uk', baidu: null },
  { name: '爱沙尼亚语', value: 'et', baidu: 'est' },
  { name: '拉脱维亚语', value: 'lv', baidu: null },
  { name: '立陶宛语', value: 'lt', baidu: null },

  // 亚洲语言
  { name: '印地语', value: 'hi', baidu: null },
  { name: '泰语', value: 'th' },
  { name: '越南语', value: 'vi', baidu: 'vie' },
  { name: '印度尼西亚语', value: 'id', baidu: null },
  { name: '马来语', value: 'ms', baidu: null },
  { name: '泰米尔语', value: 'ta', baidu: null },
  { name: '乌尔都语', value: 'ur', baidu: null },
  { name: '马拉地语', value: 'mr', baidu: null },

  // 中东语言
  { name: '阿拉伯语', value: 'ar', baidu: 'ara' },
  { name: '希伯来语', value: 'he', baidu: null },
  { name: '波斯语', value: 'fa', baidu: null },

  // 其他语言
  { name: '阿非利堪斯语', value: 'af', baidu: null },
  { name: '加泰罗尼亚语', value: 'ca', baidu: null },
  { name: '加利西亚语', value: 'gl', baidu: null },
  { name: '塔加洛语', value: 'tl', baidu: null },
  { name: '斯瓦希里语', value: 'sw', baidu: null },
  { name: '威尔士语', value: 'cy', baidu: null },
  { name: '蒙古语', value: 'mn', baidu: null, volc: null },
  {
    name: '繁体中文',
    value: 'zh-Hant',
    baidu: 'cht',
    aliyun: 'zh-tw',
    google: 'zh-TW',
  },
];

// 翻译平台类型
type TranslateProvider = 'baidu' | 'volc' | 'aliyun' | 'google' | 'doubao';

/**
 * 语言代码转换函数
 * 优化逻辑：如果平台有显式定义则使用定义值（包括 null 表示不支持），否则使用 value 作为默认值
 */
export const convertLanguageCode = (
  code: string,
  target: TranslateProvider,
): string | null => {
  const lang = supportedLanguage.find((lang) => lang.value === code);
  if (!lang) return code;

  // 检查是否有显式定义该平台的映射（包括 null）
  if (target in lang) {
    return lang[target] as string | null;
  }

  // 没有显式定义，使用 value 作为默认值
  return lang.value;
};

export const openUrl = (url) => {
  window?.ipc?.send('openUrl', url);
};

export const gitCloneSteps = {
  'Compressing objects': '打包文件',
  'Receiving objects': '下载文件',
  'Resolving deltas': '解压文件',
  'Updating workdir': '更新文件',
};

export const isSubtitleFile = (filePath) => {
  return (
    filePath?.endsWith('.srt') ||
    filePath?.endsWith('.ass') ||
    filePath?.endsWith('.ssa') ||
    filePath?.endsWith('.vtt')
  );
};

export const getModelDownloadUrl = (
  modelName: string,
  source: 'hf-mirror' | 'huggingface',
) => {
  const domain = source === 'hf-mirror' ? 'hf-mirror.com' : 'huggingface.co';
  return `https://${domain}/ggerganov/whisper.cpp/resolve/main/ggml-${modelName.toLowerCase()}.bin?download=true`;
};

// 添加支持的文件扩展名常量
export const SUPPORTED_FILE_EXTENSIONS = [
  // 视频格式
  'mp4',
  'avi',
  'mov',
  'mkv',
  'flv',
  'wmv',
  'webm',
  // 音频格式
  'mp3',
  'wav',
  'ogg',
  'aac',
  'wma',
  'flac',
  'm4a',
  'aiff',
  'ape',
  'opus',
  'ac3',
  'amr',
  'au',
  'mid',
  // 其他常见格式
  '3gp',
  'asf',
  'rm',
  'rmvb',
  'vob',
  'ts',
  'mts',
  'm2ts',
  // 字幕格式
  'srt',
  'vtt',
  'ass',
  'ssa',
] as const;

// 添加文件过滤方法
export const filterSupportedFiles = (files: File[]) => {
  return Array.from(files).filter((file) => {
    const ext = file.name.toLowerCase().split('.').pop();
    return SUPPORTED_FILE_EXTENSIONS.includes(
      ext as (typeof SUPPORTED_FILE_EXTENSIONS)[number],
    );
  });
};
