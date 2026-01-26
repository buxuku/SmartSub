import path from 'path';
import { app } from 'electron';
import os from 'os';
import { spawn } from 'child_process';

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

// 将字符串转成模板字符串
export const renderTemplate = (template, data) => {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
    result = result.replace(regex, value?.toString() || '');
  }
  return result;
};

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
  model: 'tiny',
  translateProvider: 'baidu',
  translateContent: 'onlyTranslate',
  maxConcurrentTasks: 1,
  sourceSrtSaveOption: 'noSave',
  targetSrtSaveOption: 'fileNameWithLang',
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
  { name: '希腊语', value: 'el', doubao: null },
  { name: '匈牙利语', value: 'hu' },
  { name: '挪威语', value: 'no', baidu: null, doubao: 'nb' },
  { name: '罗马尼亚语', value: 'ro', baidu: 'rom' },
  { name: '斯洛伐克语', value: 'sk', baidu: null, doubao: null },
  { name: '克罗地亚语', value: 'hr', baidu: null },
  { name: '塞尔维亚语', value: 'sr', baidu: null, doubao: null },
  { name: '斯洛文尼亚语', value: 'sl', baidu: 'slo', doubao: null },
  { name: '保加利亚语', value: 'bg', baidu: 'bul', doubao: null },
  { name: '乌克兰语', value: 'uk', baidu: null },
  { name: '爱沙尼亚语', value: 'et', baidu: 'est', doubao: null },
  { name: '拉脱维亚语', value: 'lv', baidu: null, doubao: null },
  { name: '立陶宛语', value: 'lt', baidu: null, doubao: null },

  // 亚洲语言
  { name: '印地语', value: 'hi', baidu: null, doubao: null },
  { name: '泰语', value: 'th' },
  { name: '越南语', value: 'vi', baidu: 'vie' },
  { name: '印度尼西亚语', value: 'id', baidu: null },
  { name: '马来语', value: 'ms', baidu: null },
  { name: '泰米尔语', value: 'ta', baidu: null, doubao: null },
  { name: '乌尔都语', value: 'ur', baidu: null, doubao: null },
  { name: '马拉地语', value: 'mr', baidu: null, doubao: null },

  // 中东语言
  { name: '阿拉伯语', value: 'ar', baidu: 'ara' },
  { name: '希伯来语', value: 'he', baidu: null, doubao: null },
  { name: '波斯语', value: 'fa', baidu: null, doubao: null },

  // 其他语言
  { name: '阿非利堪斯语', value: 'af', baidu: null, doubao: null },
  { name: '加泰罗尼亚语', value: 'ca', baidu: null, doubao: null },
  { name: '加利西亚语', value: 'gl', baidu: null, doubao: null },
  { name: '塔加洛语', value: 'tl', baidu: null, doubao: null },
  { name: '斯瓦希里语', value: 'sw', baidu: null, doubao: null },
  { name: '威尔士语', value: 'cy', baidu: null, doubao: null },
  { name: '蒙古语', value: 'mn', baidu: null, volc: null, doubao: null },
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
