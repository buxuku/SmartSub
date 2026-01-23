/**
 * 字幕样式工具函数
 * 用于前端 CSS 预览模拟
 */

import type {
  SubtitleStyle,
  SubtitleAlignment,
} from '../../../../types/subtitleMerge';

/**
 * 将字幕样式转换为 CSS 样式对象
 * 用于前端实时预览
 */
export function subtitleStyleToCSS(style: SubtitleStyle): React.CSSProperties {
  const css: React.CSSProperties = {
    fontFamily: style.fontName,
    fontSize: `${style.fontSize}px`,
    color: style.primaryColor,
    fontWeight: style.bold ? 'bold' : 'normal',
    fontStyle: style.italic ? 'italic' : 'normal',
    textDecoration: style.underline ? 'underline' : 'none',
    textAlign: getTextAlign(style.alignment),
    padding: '4px 8px',
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  // 根据边框样式处理
  if (style.borderStyle === 3) {
    // 背景框模式
    css.backgroundColor = hexToRgba(style.backColor, 0.7);
    css.borderRadius = '4px';
  } else {
    // 边框 + 阴影模式
    const shadows: string[] = [];

    // 文字描边效果
    if (style.outline > 0) {
      const outlineSize = Math.min(style.outline, 4);
      for (let x = -outlineSize; x <= outlineSize; x++) {
        for (let y = -outlineSize; y <= outlineSize; y++) {
          if (x !== 0 || y !== 0) {
            shadows.push(`${x}px ${y}px 0 ${style.outlineColor}`);
          }
        }
      }
    }

    // 阴影效果
    if (style.shadow > 0) {
      shadows.push(
        `${style.shadow}px ${style.shadow}px ${style.shadow}px ${style.backColor}`,
      );
    }

    if (shadows.length > 0) {
      css.textShadow = shadows.join(', ');
    }
  }

  return css;
}

/**
 * 获取字幕容器的定位样式
 */
export function getSubtitleContainerStyle(
  style: SubtitleStyle,
  containerWidth: number,
  containerHeight: number,
): React.CSSProperties {
  const css: React.CSSProperties = {
    position: 'absolute',
    display: 'flex',
    justifyContent: getJustifyContent(style.alignment),
    alignItems: getAlignItems(style.alignment),
    padding: `${style.marginV}px ${style.marginR}px ${style.marginV}px ${style.marginL}px`,
    boxSizing: 'border-box',
    width: '100%',
    pointerEvents: 'none',
  };

  // 根据垂直对齐设置位置
  const verticalPosition = getVerticalPosition(style.alignment);
  if (verticalPosition === 'top') {
    css.top = 0;
  } else if (verticalPosition === 'middle') {
    css.top = '50%';
    css.transform = 'translateY(-50%)';
  } else {
    css.bottom = 0;
  }

  return css;
}

/**
 * 根据对齐方式获取文本对齐
 */
function getTextAlign(
  alignment: SubtitleAlignment,
): 'left' | 'center' | 'right' {
  // 1,4,7 = 左
  // 2,5,8 = 中
  // 3,6,9 = 右
  const col = (alignment - 1) % 3;
  if (col === 0) return 'left';
  if (col === 1) return 'center';
  return 'right';
}

/**
 * 获取水平 flex 对齐
 */
function getJustifyContent(
  alignment: SubtitleAlignment,
): 'flex-start' | 'center' | 'flex-end' {
  const col = (alignment - 1) % 3;
  if (col === 0) return 'flex-start';
  if (col === 1) return 'center';
  return 'flex-end';
}

/**
 * 获取垂直 flex 对齐
 */
function getAlignItems(
  alignment: SubtitleAlignment,
): 'flex-start' | 'center' | 'flex-end' {
  const row = Math.floor((alignment - 1) / 3);
  if (row === 0) return 'flex-end'; // 1,2,3 底部
  if (row === 1) return 'center'; // 4,5,6 中间
  return 'flex-start'; // 7,8,9 顶部
}

/**
 * 获取垂直位置
 */
function getVerticalPosition(
  alignment: SubtitleAlignment,
): 'top' | 'middle' | 'bottom' {
  // 1,2,3 = 底部
  // 4,5,6 = 中间
  // 7,8,9 = 顶部
  const row = Math.floor((alignment - 1) / 3);
  if (row === 0) return 'bottom';
  if (row === 1) return 'middle';
  return 'top';
}

/**
 * 十六进制颜色转 rgba
 */
function hexToRgba(hex: string, alpha: number = 1): string {
  // 移除 # 前缀
  const cleanHex = hex.replace('#', '');

  // 解析 RGB 值
  const r = parseInt(cleanHex.substr(0, 2), 16);
  const g = parseInt(cleanHex.substr(2, 2), 16);
  const b = parseInt(cleanHex.substr(4, 2), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 格式化时长
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
