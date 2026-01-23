/**
 * 字幕合并功能常量和预设样式
 */

import type { SubtitleStyle, StylePreset } from '../../../types/subtitleMerge';

/**
 * 默认字幕样式
 */
export const DEFAULT_STYLE: SubtitleStyle = {
  fontName: 'Arial',
  fontSize: 24,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  backColor: '#000000',
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
      bold: false,
      italic: false,
      underline: false,
      borderStyle: 3,
      outline: 0,
      shadow: 0,
      alignment: 2,
      marginL: 20,
      marginR: 20,
      marginV: 15,
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
