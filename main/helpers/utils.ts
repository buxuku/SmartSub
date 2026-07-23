import path from 'path';
import { app } from 'electron';
import os from 'os';
import { spawn } from 'child_process';
import { renderTemplate } from './template';

export { renderTemplate } from './template';

/**
 * 敏感字段列表（小写形式，用于不区分大小写匹配）
 * 包含 API 密钥、密码、令牌等敏感信息的字段名
 */
const SENSITIVE_FIELDS = [
  'apikey',
  'apisecret',
  'secret',
  'secretkey',
  'password',
  'token',
  'accesstoken',
  'accesskey',
  'accesskeysecret',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'api_key',
  'api_secret',
  'secret_key',
  'access_token',
  'access_key',
];

/**
 * 检查字段名是否为敏感字段
 */
function isSensitiveField(fieldName: string): boolean {
  const lowerFieldName = fieldName.toLowerCase();
  return SENSITIVE_FIELDS.some(
    (sensitive) =>
      lowerFieldName === sensitive || lowerFieldName.includes(sensitive),
  );
}

/**
 * 对敏感值进行脱敏处理
 * 保留前2位和后2位，中间用 **** 替换
 */
function maskValue(value: string): string {
  if (!value || typeof value !== 'string') {
    return value;
  }

  const length = value.length;
  if (length <= 4) {
    return '****';
  }

  const visibleChars = Math.min(2, Math.floor(length / 4));
  const prefix = value.substring(0, visibleChars);
  const suffix = value.substring(length - visibleChars);
  return `${prefix}****${suffix}`;
}

/**
 * 递归处理对象，对敏感字段进行脱敏
 * @param obj 要处理的对象
 * @param maxDepth 最大递归深度，防止循环引用
 */
export function sanitizeObject(obj: any, maxDepth: number = 10): any {
  if (maxDepth <= 0) {
    return '[Max depth exceeded]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, maxDepth - 1));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveField(key)) {
      // 对敏感字段进行脱敏
      sanitized[key] =
        typeof value === 'string' ? maskValue(value) : '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      // 递归处理嵌套对象
      sanitized[key] = sanitizeObject(value, maxDepth - 1);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * 对日志消息进行脱敏处理
 * 支持处理字符串中的 JSON 对象和常见敏感值模式
 */
export function sanitizeLogMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return message;
  }

  let sanitized = message;

  // 尝试检测和处理 JSON 对象
  const jsonPattern = /\{[\s\S]*\}/g;
  const jsonMatches = message.match(jsonPattern);

  if (jsonMatches) {
    for (const jsonStr of jsonMatches) {
      try {
        const parsed = JSON.parse(jsonStr);
        const sanitizedObj = sanitizeObject(parsed);
        sanitized = sanitized.replace(
          jsonStr,
          JSON.stringify(sanitizedObj, null, 2),
        );
      } catch {
        // 不是有效的 JSON，继续处理下一个
      }
    }
  }

  // 处理常见的敏感值模式（如 apiKey: "xxx", "apiKey": "xxx"）
  const sensitivePatterns = SENSITIVE_FIELDS.map((field) => {
    // 匹配 key: "value" 或 key: 'value' 或 "key": "value" 等模式
    const pattern = new RegExp(
      `(["']?${field}["']?\\s*[:=]\\s*)["']([^"']+)["']`,
      'gi',
    );
    return { field, pattern };
  });

  for (const { pattern } of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, (match, prefix, value) => {
      return `${prefix}"${maskValue(value)}"`;
    });
  }

  return sanitized;
}

export const isDarwin = () => os.platform() === 'darwin';

export const isWin32 = () => os.platform() === 'win32';

export const isAppleSilicon = () => {
  return os.platform() === 'darwin' && os.arch() === 'arm64';
};

export const getExtraResourcesPath = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return isProd
    ? path.join(process.resourcesPath, 'extraResources')
    : path.join(app.getAppPath(), 'extraResources');
};

export function runCommand(command, args, onProcess = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const sendProgress = throttle((data) => {
      onProcess && onProcess(data?.toString());
    }, 300);
    child.stdout.on('data', (data) => {
      // console.log(`${data} \n`);
      sendProgress(data);
    });

    child.stderr.on('data', (data) => {
      // console.error(`${data} \n`);
      sendProgress(data);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} process error ${code}`));
      } else {
        resolve(true);
      }
    });
  });
}

function throttle(func, limit) {
  let lastFunc;
  let lastRan;
  return function (...args) {
    const context = this;
    if (!lastRan) {
      func.apply(context, args);
      lastRan = Date.now();
    } else {
      clearTimeout(lastFunc);
      lastFunc = setTimeout(
        function () {
          if (Date.now() - lastRan >= limit) {
            func.apply(context, args);
            lastRan = Date.now();
          }
        },
        limit - (Date.now() - lastRan),
      );
    }
  };
}

// 删除 processFile 函数

export const defaultUserConfig = {
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  customTargetSrtFileName: '${fileName}.${targetLanguage}',
  customSourceSrtFileName: '${fileName}.${sourceLanguage}',
  // 逐任务引擎：任务携带引擎，后端按此解析执行（缺省 builtin，任务页默认逻辑会按"上次使用"细化）
  transcriptionEngine: 'builtin',
  model: 'tiny',
  translateProvider: 'baidu',
  translateContent: 'onlyTranslate',
  maxConcurrentTasks: 1,
  sourceSrtSaveOption: 'noSave',
  targetSrtSaveOption: 'fileNameWithLang',
  subtitleOutputFormat: 'srt',
  maxSubtitleChars: 0,
  removeChinesePunctuation: false,
};

export function getSrtFileName(
  option: string,
  fileName: string,
  language: string,
  customFileName: string,
  templateData: { [key: string]: string },
): string {
  switch (option) {
    case 'noSave':
      return `${fileName}_temp`;
    case 'fileName':
      return fileName;
    case 'fileNameWithLang':
      return `${fileName}.${language}`;
    case 'custom':
      return renderTemplate(customFileName, templateData);
    default:
      return `${fileName}_temp`;
  }
}

/**
 * 支持的语言列表
 * 优化结构：默认使用 value 作为各平台的语言代码
 * 只有当某平台的代码与 value 不同时才显式定义，不支持则定义为 null
 */
export const supportedLanguage = [
  // 最常用语言
  // 讯飞机器翻译简体中文代码为 cn（非 zh）；小牛/腾讯均使用 zh；Bing 简体中文为 zh-Hans
  {
    name: '中文',
    value: 'zh',
    xunfei: 'cn',
    bing: 'zh-Hans',
    qwenMt: 'Chinese',
  },
  { name: '英语', value: 'en', qwenMt: 'English' },
  { name: '日语', value: 'ja', baidu: 'jp', qwenMt: 'Japanese' },
  { name: '韩语', value: 'ko', baidu: 'kor', qwenMt: 'Korean' },
  { name: '法语', value: 'fr', baidu: 'fra', qwenMt: 'French' },
  { name: '德语', value: 'de', qwenMt: 'German' },
  { name: '西班牙语', value: 'es', baidu: 'spa', qwenMt: 'Spanish' },
  { name: '俄语', value: 'ru', qwenMt: 'Russian' },
  { name: '葡萄牙语', value: 'pt', qwenMt: 'Portuguese' },
  { name: '意大利语', value: 'it', qwenMt: 'Italian' },

  // 其他欧洲语言
  { name: '荷兰语', value: 'nl', qwenMt: 'Dutch' },
  { name: '波兰语', value: 'pl', qwenMt: 'Polish' },
  { name: '土耳其语', value: 'tr', baidu: null, qwenMt: 'Turkish' },
  { name: '瑞典语', value: 'sv', baidu: 'swe', qwenMt: 'Swedish' },
  { name: '捷克语', value: 'cs', qwenMt: 'Czech' },
  { name: '丹麦语', value: 'da', baidu: 'dan', qwenMt: 'Danish' },
  { name: '芬兰语', value: 'fi', baidu: 'fin', qwenMt: 'Finnish' },
  { name: '希腊语', value: 'el', doubao: null, qwenMt: 'Greek' },
  { name: '匈牙利语', value: 'hu', qwenMt: 'Hungarian' },
  {
    name: '挪威语',
    value: 'no',
    baidu: null,
    doubao: 'nb',
    bing: 'nb',
    qwenMt: 'Norwegian Bokmål',
  },
  { name: '罗马尼亚语', value: 'ro', baidu: 'rom', qwenMt: 'Romanian' },
  {
    name: '斯洛伐克语',
    value: 'sk',
    baidu: null,
    doubao: null,
    qwenMt: 'Slovak',
  },
  { name: '克罗地亚语', value: 'hr', baidu: null, qwenMt: 'Croatian' },
  {
    name: '塞尔维亚语',
    value: 'sr',
    baidu: null,
    doubao: null,
    qwenMt: 'Serbian',
  },
  {
    name: '斯洛文尼亚语',
    value: 'sl',
    baidu: 'slo',
    doubao: null,
    qwenMt: 'Slovenian',
  },
  {
    name: '保加利亚语',
    value: 'bg',
    baidu: 'bul',
    doubao: null,
    qwenMt: 'Bulgarian',
  },
  { name: '乌克兰语', value: 'uk', baidu: null, qwenMt: 'Ukrainian' },
  {
    name: '爱沙尼亚语',
    value: 'et',
    baidu: 'est',
    doubao: null,
    qwenMt: 'Estonian',
  },
  {
    name: '拉脱维亚语',
    value: 'lv',
    baidu: null,
    doubao: null,
    qwenMt: 'Latvian',
  },
  {
    name: '立陶宛语',
    value: 'lt',
    baidu: null,
    doubao: null,
    qwenMt: 'Lithuanian',
  },

  // 亚洲语言
  { name: '印地语', value: 'hi', baidu: null, doubao: null, qwenMt: 'Hindi' },
  { name: '泰语', value: 'th', qwenMt: 'Thai' },
  { name: '越南语', value: 'vi', baidu: 'vie', qwenMt: 'Vietnamese' },
  { name: '印度尼西亚语', value: 'id', baidu: null, qwenMt: 'Indonesian' },
  { name: '马来语', value: 'ms', baidu: null, qwenMt: 'Malay' },
  {
    name: '泰米尔语',
    value: 'ta',
    baidu: null,
    doubao: null,
    qwenMt: 'Tamil',
  },
  {
    name: '乌尔都语',
    value: 'ur',
    baidu: null,
    doubao: null,
    qwenMt: 'Urdu',
  },
  {
    name: '马拉地语',
    value: 'mr',
    baidu: null,
    doubao: null,
    qwenMt: 'Marathi',
  },

  // 中东语言
  { name: '阿拉伯语', value: 'ar', baidu: 'ara', qwenMt: 'Arabic' },
  {
    name: '希伯来语',
    value: 'he',
    baidu: null,
    doubao: null,
    qwenMt: 'Hebrew',
  },
  {
    name: '波斯语',
    value: 'fa',
    baidu: null,
    doubao: null,
    qwenMt: 'Western Persian',
  },

  // 其他语言
  {
    name: '阿非利堪斯语',
    value: 'af',
    baidu: null,
    doubao: null,
    qwenMt: 'Afrikaans',
  },
  {
    name: '加泰罗尼亚语',
    value: 'ca',
    baidu: null,
    doubao: null,
    qwenMt: 'Catalan',
  },
  {
    name: '加利西亚语',
    value: 'gl',
    baidu: null,
    doubao: null,
    qwenMt: 'Galician',
  },
  {
    name: '塔加洛语',
    value: 'tl',
    baidu: null,
    doubao: null,
    bing: 'fil',
    qwenMt: 'Tagalog',
  },
  {
    name: '斯瓦希里语',
    value: 'sw',
    baidu: null,
    doubao: null,
    qwenMt: 'Swahili',
  },
  {
    name: '威尔士语',
    value: 'cy',
    baidu: null,
    doubao: null,
    qwenMt: 'Welsh',
  },
  {
    name: '蒙古语',
    value: 'mn',
    baidu: null,
    volc: null,
    doubao: null,
    qwenMt: null,
  },
  {
    name: '繁体中文',
    value: 'zh-Hant',
    baidu: 'cht',
    aliyun: 'zh-tw',
    google: 'zh-TW',
    niutrans: 'cht',
    tencent: 'zh-TW',
    xunfei: 'cht',
    qwenMt: 'Traditional Chinese',
  },
  // 粤语：主要用于 Whisper 语音识别源语言；Google 翻译无粤语，标记为不支持
  { name: '粤语', value: 'yue', google: null, qwenMt: 'Cantonese' },
];

// 翻译平台类型
type TranslateProvider =
  | 'baidu'
  | 'volc'
  | 'aliyun'
  | 'google'
  | 'bing'
  | 'doubao'
  | 'niutrans'
  | 'tencent'
  | 'xunfei'
  | 'qwenMt';

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
