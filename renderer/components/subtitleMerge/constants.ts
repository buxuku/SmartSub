/**
 * 字幕合并功能常量和预设样式
 */

import type { SubtitleStyle, StylePreset } from '../../../types/subtitleMerge';

/**
 * 按平台返回 CJK 友好的默认字体。
 * Arial 不含 CJK 字形，中文字幕烧录时会退化到 libass 的随机回退字体。
 */
export const getPlatformDefaultFont = (): string => {
  if (typeof navigator === 'undefined') return 'Arial';
  const ua = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
  if (/mac/i.test(ua)) return 'PingFang SC';
  if (/win/i.test(ua)) return 'Microsoft YaHei';
  return 'Noto Sans CJK SC';
};

/**
 * 默认字幕样式
 */
export const DEFAULT_STYLE: SubtitleStyle = {
  fontName: 'Arial',
  fontSize: 24,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  backColor: '#000000',
  backOpacity: 50,
  bold: false,
  italic: false,
  underline: false,
  borderStyle: 1,
  outline: 2,
  shadow: 1,
  alignment: 2,
  marginL: 20,
  marginR: 20,
  marginV: 20,
};

/**
 * 默认字幕样式（字体按运行平台动态决定）
 */
export const getDefaultStyle = (): SubtitleStyle => ({
  ...DEFAULT_STYLE,
  fontName: getPlatformDefaultFont(),
});

/**
 * 预设样式列表
 */
export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'bilibili_knowledge',
    name: 'B站知识区',
    nameKey: 'presetBilibili',
    style: {
      ...DEFAULT_STYLE,
      fontName: 'Arial Unicode MS',
      fontSize: 30,
      bold: true,
      borderStyle: 3,
      backOpacity: 100,
      outline: 3,
      shadow: 0,
      highlightColor: '#FFFF00',
      highlightTerms: ['SmartSub'],
    },
  },
  {
    id: 'netflix_bilingual',
    name: 'Netflix 双语',
    nameKey: 'presetNetflix',
    style: {
      ...DEFAULT_STYLE,
      fontName: 'Courier New',
      fontSize: 22,
      primaryColor: '#FFFF00',
      secondLineColor: '#FFFFFF',
      outline: 0.6,
      shadow: 1,
      backOpacity: 80,
      marginV: 24,
    },
  },
  {
    id: 'variety_glow',
    name: '综艺花字',
    nameKey: 'presetVariety',
    style: {
      ...DEFAULT_STYLE,
      fontName: 'Arial Unicode MS',
      fontSize: 32,
      bold: true,
      italic: true,
      primaryColor: '#FFFFFF',
      outlineColor: '#80205D',
      outline: 3.5,
      shadow: 0,
      glow: 3,
      glowColor: '#F472B6',
    },
  },
  {
    id: 'classic',
    name: '经典白字黑边',
    nameKey: 'presetClassic',
    style: {
      fontName: 'Arial',
      fontSize: 24,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      backColor: '#000000',
      backOpacity: 50,
      bold: false,
      italic: false,
      underline: false,
      borderStyle: 1,
      outline: 2,
      shadow: 1,
      alignment: 2,
      marginL: 20,
      marginR: 20,
      marginV: 20,
    },
  },
  {
    id: 'movie',
    name: '电影字幕',
    nameKey: 'presetMovie',
    style: {
      fontName: 'Georgia',
      fontSize: 28,
      primaryColor: '#FFFFC8',
      outlineColor: '#000000',
      backColor: '#000000',
      backOpacity: 50,
      bold: false,
      italic: false,
      underline: false,
      borderStyle: 1,
      outline: 2,
      shadow: 2,
      alignment: 2,
      marginL: 30,
      marginR: 30,
      marginV: 30,
    },
  },
  {
    id: 'youtube',
    name: 'YouTube风格',
    nameKey: 'presetYoutube',
    style: {
      fontName: 'Roboto',
      fontSize: 22,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      backColor: '#000000',
      // YouTube 风格：背景框更实一些，接近官方播放器观感
      backOpacity: 80,
      bold: false,
      italic: false,
      underline: false,
      borderStyle: 3,
      // 背景框模式下 outline 语义是框内边距（libass 要求 >0 才绘制框）
      outline: 2,
      shadow: 0,
      alignment: 2,
      marginL: 20,
      marginR: 20,
      marginV: 15,
    },
  },
  {
    id: 'black_box',
    name: '黑底白字',
    nameKey: 'presetBlackBox',
    style: {
      fontName: 'Arial',
      fontSize: 24,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      backColor: '#000000',
      // 完全不透明：字幕区域全遮挡，适合画面杂乱或需要突出字幕的场景
      backOpacity: 100,
      bold: false,
      italic: false,
      underline: false,
      borderStyle: 3,
      outline: 3,
      shadow: 0,
      alignment: 2,
      marginL: 20,
      marginR: 20,
      marginV: 20,
    },
  },
  {
    id: 'clean',
    name: '清新简约',
    nameKey: 'presetClean',
    style: {
      fontName: 'Helvetica Neue',
      fontSize: 22,
      primaryColor: '#FFFFFF',
      outlineColor: '#333333',
      backColor: '#000000',
      backOpacity: 50,
      bold: false,
      italic: false,
      underline: false,
      borderStyle: 1,
      outline: 1,
      shadow: 0,
      alignment: 2,
      marginL: 20,
      marginR: 20,
      marginV: 25,
    },
  },
  {
    id: 'bold_impact',
    name: '醒目加粗',
    nameKey: 'presetBoldImpact',
    style: {
      fontName: 'Impact',
      fontSize: 26,
      primaryColor: '#FFFF00',
      outlineColor: '#000000',
      backColor: '#000000',
      backOpacity: 50,
      bold: true,
      italic: false,
      underline: false,
      borderStyle: 1,
      outline: 3,
      shadow: 2,
      alignment: 2,
      marginL: 20,
      marginR: 20,
      marginV: 20,
    },
  },
];

/**
 * 字号范围
 */
export const FONT_SIZE_RANGE = {
  min: 12,
  max: 72,
  default: 24,
};

/**
 * 边框宽度范围
 */
export const OUTLINE_RANGE = {
  min: 0,
  max: 10,
  default: 2,
};

/**
 * 阴影距离范围
 */
export const SHADOW_RANGE = {
  min: 0,
  max: 10,
  default: 1,
};

/**
 * 背景不透明度范围（百分比）
 */
export const BACK_OPACITY_RANGE = {
  min: 0,
  max: 100,
  step: 5,
  default: 50,
};

/**
 * 边距范围
 */
export const MARGIN_RANGE = {
  min: 0,
  max: 200,
  default: 20,
};

/**
 * 边框样式选项
 */
export const BORDER_STYLE_OPTIONS = [
  { value: 1, label: '边框+阴影', labelKey: 'borderStyleOutline' },
  { value: 3, label: '背景框', labelKey: 'borderStyleBox' },
];
