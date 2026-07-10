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
 * 常用字体列表
 */
export const FONT_LIST = [
  // 系统通用字体
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Helvetica Neue', label: 'Helvetica Neue' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Impact', label: 'Impact' },
  // 中文字体
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'SimHei', label: '黑体' },
  { value: 'SimSun', label: '宋体' },
  { value: 'KaiTi', label: '楷体' },
  { value: 'PingFang SC', label: '苹方' },
  { value: 'Noto Sans SC', label: 'Noto Sans SC' },
  { value: 'Noto Sans CJK SC', label: 'Noto Sans CJK SC' },
  { value: 'Source Han Sans SC', label: '思源黑体' },
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
