/**
 * 字幕样式工具函数
 * 用于前端 CSS 预览模拟
 */

import type {
  SubtitleStyle,
  SubtitleAlignment,
} from '../../../../types/subtitleMerge';

/**
 * libass 烧录字幕的「等效脚本高度」：FontSize 以它为基准，再等比缩放到视频实际高度。
 * 预览里把「预览盒高 / 该值」作为缩放系数，CSS 模拟字号即≈烧录后字号，
 * 与预览框大小、视频分辨率均无关地保持所见即所得。
 *
 * 该值由「字形墨迹高度」实测标定（比按 em 反推更可靠，整块字符 █ 会超出 em 导致偏差）：
 *   - libass：Hiragino「中/字」FontSize=72、帧高 720 → 墨迹高 ≈141px，占帧高 ≈19.6%；
 *   - 浏览器 canvas measureText：CJK 字形墨迹高 ≈ 0.91·font-size（中文字体几乎填满 em）。
 *   令两者占比相等 → 等效高度 = 72 × 0.91 / 0.196 ≈ 333（与字体、分辨率基本无关）。
 * 实测 K=333 时预览(PingFang)与烧录(Hiragino)字号在 24/72 档均吻合（偏差 <1%）。
 */
export const LIBASS_SRT_PLAYRES_Y = 333;

/**
 * 将字幕样式转换为 CSS 样式对象
 * 用于前端实时预览
 * @param scale 预览盒相对 libass 脚本高度的缩放系数（盒高/288），默认 1
 */
export function subtitleStyleToCSS(
  style: SubtitleStyle,
  scale: number = 1,
): React.CSSProperties {
  const s = scale > 0 ? scale : 1;
  const css: React.CSSProperties = {
    fontFamily: style.fontName,
    fontSize: `${style.fontSize * s}px`,
    color: style.primaryColor,
    fontWeight: style.bold ? 'bold' : 'normal',
    fontStyle: style.italic ? 'italic' : 'normal',
    textDecoration: style.underline ? 'underline' : 'none',
    textAlign: getTextAlign(style.alignment),
    padding: `${4 * s}px ${8 * s}px`,
    // libass 行距≈1.2em，预览与之对齐，避免多行字幕预览比烧录结果偏高
    lineHeight: 1.2,
    // 折行行为对齐 libass（force_style 未设 WrapStyle，默认仅在空格处断行）：
    //   - pre-wrap：保留显式换行与空格，并在空格处提供软换行点（英文/含空格文本会折行）；
    //   - word-break: keep-all：禁止在 CJK 字符间断行，纯中文（无空格）长行不折行而是
    //     溢出帧、由预览框 overflow-hidden 居中裁剪；
    //   - overflow-wrap: normal：不强制打断长串。
    // 效果：仅中文不换行、含空格按空格换行，与烧录结果一致（所见即所得）。
    whiteSpace: 'pre-wrap',
    wordBreak: 'keep-all',
    overflowWrap: 'normal',
  };

  // 背景不透明度（0-100%，缺省 50，与烧录端 backOpacityToAssAlpha 同语义）
  const backAlpha = (style.backOpacity ?? 50) / 100;

  // 根据边框样式处理
  if (style.borderStyle === 3) {
    // 背景框模式：颜色与不透明度取用户设置（与烧录一致）；
    // libass 的背景框是直角矩形，不加圆角，保证降级预览不失真
    css.backgroundColor = hexToRgba(style.backColor, backAlpha);
  } else {
    // 边框 + 阴影模式
    const shadows: string[] = [];

    // 文字描边效果（描边偏移按比例缩放，保持与字号一致的视觉粗细）
    if (style.outline > 0) {
      const outlineSize = Math.min(style.outline, 4);
      for (let x = -outlineSize; x <= outlineSize; x++) {
        for (let y = -outlineSize; y <= outlineSize; y++) {
          if (x !== 0 || y !== 0) {
            shadows.push(`${x * s}px ${y * s}px 0 ${style.outlineColor}`);
          }
        }
      }
    }

    // 阴影效果（阴影色同样应用背景不透明度，与烧录端 BackColour alpha 一致）
    if (style.shadow > 0) {
      shadows.push(
        `${style.shadow * s}px ${style.shadow * s}px ${style.shadow * s}px ${hexToRgba(style.backColor, backAlpha)}`,
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
 * @param scale 预览盒相对 libass 脚本高度的缩放系数（盒高/288），默认 1
 */
export function getSubtitleContainerStyle(
  style: SubtitleStyle,
  containerWidth: number,
  containerHeight: number,
  scale: number = 1,
): React.CSSProperties {
  const s = scale > 0 ? scale : 1;
  const css: React.CSSProperties = {
    position: 'absolute',
    display: 'flex',
    justifyContent: getJustifyContent(style.alignment),
    alignItems: getAlignItems(style.alignment),
    padding: `${style.marginV * s}px ${style.marginR * s}px ${style.marginV * s}px ${style.marginL * s}px`,
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
