import path from 'path';
import { app } from 'electron';
import os from 'os';
import { spawn } from 'child_process';

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

export const supportedLanguage = [
  // 最常用语言
  { name: '中文', value: 'zh', baidu: 'zh', volc: 'zh', aliyun: 'zh' },
  { name: '英语', value: 'en', baidu: 'en', volc: 'en', aliyun: 'en' },
  { name: '日语', value: 'ja', baidu: 'jp', volc: 'ja', aliyun: 'ja' },
  { name: '韩语', value: 'ko', baidu: 'kor', volc: 'ko', aliyun: 'ko' },
  { name: '法语', value: 'fr', baidu: 'fra', volc: 'fr', aliyun: 'fr' },
  { name: '德语', value: 'de', baidu: 'de', volc: 'de', aliyun: 'de' },
  { name: '西班牙语', value: 'es', baidu: 'spa', volc: 'es', aliyun: 'es' },
  { name: '俄语', value: 'ru', baidu: 'ru', volc: 'ru', aliyun: 'ru' },
  { name: '葡萄牙语', value: 'pt', baidu: 'pt', volc: 'pt', aliyun: 'pt' },
  { name: '意大利语', value: 'it', baidu: 'it', volc: 'it', aliyun: 'it' },

  // 其他欧洲语言
  { name: '荷兰语', value: 'nl', baidu: 'nl', volc: 'nl', aliyun: 'nl' },
  { name: '波兰语', value: 'pl', baidu: 'pl', volc: 'pl', aliyun: 'pl' },
  { name: '土耳其语', value: 'tr', baidu: null, volc: 'tr', aliyun: 'tr' },
  { name: '瑞典语', value: 'sv', baidu: 'swe', volc: 'sv', aliyun: 'sv' },
  { name: '捷克语', value: 'cs', baidu: 'cs', volc: 'cs', aliyun: 'cs' },
  { name: '丹麦语', value: 'da', baidu: 'dan', volc: 'da', aliyun: 'da' },
  { name: '芬兰语', value: 'fi', baidu: 'fin', volc: 'fi', aliyun: 'fi' },
  { name: '希腊语', value: 'el', baidu: 'el', volc: 'el', aliyun: 'el' },
  { name: '匈牙利语', value: 'hu', baidu: 'hu', volc: 'hu', aliyun: 'hu' },
  { name: '挪威语', value: 'no', baidu: null, volc: 'no', aliyun: 'no' },
  { name: '罗马尼亚语', value: 'ro', baidu: 'rom', volc: 'ro', aliyun: 'ro' },
  { name: '斯洛伐克语', value: 'sk', baidu: null, volc: 'sk', aliyun: 'sk' },
  { name: '克罗地亚语', value: 'hr', baidu: null, volc: 'hr', aliyun: 'hr' },
  { name: '塞尔维亚语', value: 'sr', baidu: null, volc: 'sr', aliyun: 'sr' },
  { name: '斯洛文尼亚语', value: 'sl', baidu: 'slo', volc: 'sl', aliyun: 'sl' },
  { name: '保加利亚语', value: 'bg', baidu: 'bul', volc: 'bg', aliyun: 'bg' },
  { name: '乌克兰语', value: 'uk', baidu: null, volc: 'uk', aliyun: 'uk' },
  { name: '爱沙尼亚语', value: 'et', baidu: 'est', volc: 'et', aliyun: 'et' },
  { name: '拉脱维亚语', value: 'lv', baidu: null, volc: 'lv', aliyun: 'lv' },
  { name: '立陶宛语', value: 'lt', baidu: null, volc: 'lt', aliyun: 'lt' },

  // 亚洲语言
  { name: '印地语', value: 'hi', baidu: null, volc: 'hi', aliyun: 'hi' },
  { name: '泰语', value: 'th', baidu: 'th', volc: 'th', aliyun: 'th' },
  { name: '越南语', value: 'vi', baidu: 'vie', volc: 'vi', aliyun: 'vi' },
  { name: '印度尼西亚语', value: 'id', baidu: null, volc: 'id', aliyun: 'id' },
  { name: '马来语', value: 'ms', baidu: null, volc: 'ms', aliyun: 'ms' },
  { name: '泰米尔语', value: 'ta', baidu: null, volc: 'ta', aliyun: 'ta' },
  { name: '乌尔都语', value: 'ur', baidu: null, volc: 'ur', aliyun: 'ur' },
  { name: '马拉地语', value: 'mr', baidu: null, volc: 'mr', aliyun: 'mr' },

  // 中东语言
  { name: '阿拉伯语', value: 'ar', baidu: 'ara', volc: 'ar', aliyun: 'ar' },
  { name: '希伯来语', value: 'he', baidu: null, volc: 'he', aliyun: 'he' },
  { name: '波斯语', value: 'fa', baidu: null, volc: 'fa', aliyun: 'fa' },

  // 其他语言
  { name: '阿非利堪斯语', value: 'af', baidu: null, volc: 'af', aliyun: 'af' },
  { name: '加泰罗尼亚语', value: 'ca', baidu: null, volc: 'ca', aliyun: 'ca' },
  { name: '加利西亚语', value: 'gl', baidu: null, volc: 'gl', aliyun: 'gl' },
  { name: '塔加洛语', value: 'tl', baidu: null, volc: 'tl', aliyun: 'tl' },
  { name: '斯瓦希里语', value: 'sw', baidu: null, volc: 'sw', aliyun: 'sw' },
  { name: '威尔士语', value: 'cy', baidu: null, volc: 'cy', aliyun: 'cy' },
  { name: '蒙古语', value: 'Mongolian', baidu: null, volc: null, aliyun: 'mn' },
];

// 语言代码转换函数
export const convertLanguageCode = (
  code: string,
  target: 'baidu' | 'volc' | 'aliyun',
) => {
  const lang = supportedLanguage.find((lang) => lang.value === code);
  if (!lang) return code;
  return lang[target];
};
