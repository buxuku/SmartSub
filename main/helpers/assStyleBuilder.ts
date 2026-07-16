/**
 * ASS 文档生成模块：SubtitleStyle → 完整 ASS 文本。
 *
 * 硬字幕烧录与预览（JASSUB）共用同一份生成逻辑，保证所见即所得。
 *
 * 脚本空间刻意沿用 PlayResX=384 / PlayResY=288 —— 这正是 ffmpeg 对 SRT
 * 隐式转 ASS 时使用的脚本空间（libass 默认），因此既有用户保存的字号、
 * 边距、描边、阴影数值的烧录观感与旧版 force_style 方案完全一致（零回归），
 * 同时语义从「隐式默认」变为「显式声明」：任意分辨率按 视频高度/288 等比缩放。
 */

import type {
  SubtitleStyle,
  SubtitleAlignment,
} from '../../types/subtitleMerge';
import type { SubtitleCue } from './subtitleFormats';
import { formatAssTime } from './subtitleFormats';

/** 烧录/预览共用的 ASS 脚本空间（与 ffmpeg 的 SRT 隐式转换一致） */
export const ASS_PLAY_RES_X = 384;
export const ASS_PLAY_RES_Y = 288;

/** 背景不透明度缺省值（百分比，≈旧版硬编码 alpha=128） */
export const DEFAULT_BACK_OPACITY = 50;

/**
 * 将前端 numpad 风格的 Alignment 转换为 ASS/SSA legacy Alignment。
 *
 * 前端 numpad 风格：7/8/9=上排，4/5/6=中排，1/2/3=下排（左/中/右）。
 * SSA legacy 编码（[V4+ Styles] 中 libass 亦接受）：
 *   底部 1/2/3；中部 9/10/11；顶部 5/6/7。
 */
export function convertAlignment(numpadAlignment: SubtitleAlignment): number {
  const alignmentMap: Record<SubtitleAlignment, number> = {
    1: 1,
    2: 2,
    3: 3,
    4: 9,
    5: 10,
    6: 11,
    7: 5,
    8: 6,
    9: 7,
  };
  return alignmentMap[numpadAlignment] || 2;
}

/**
 * 将 CSS 颜色转换为 ASS 颜色格式
 * CSS: #RRGGBB 或 rgba(r, g, b, a)
 * ASS: &HAABBGGRR（Alpha, Blue, Green, Red；alpha 00=不透明 FF=全透明）
 */
export function cssColorToAss(cssColor: string, alpha: number = 0): string {
  let r: number, g: number, b: number;

  if (cssColor.startsWith('#')) {
    const hex = cssColor.slice(1);
    r = parseInt(hex.substr(0, 2), 16);
    g = parseInt(hex.substr(2, 2), 16);
    b = parseInt(hex.substr(4, 2), 16);
  } else if (cssColor.startsWith('rgb')) {
    const match = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      r = parseInt(match[1]);
      g = parseInt(match[2]);
      b = parseInt(match[3]);
    } else {
      r = 255;
      g = 255;
      b = 255;
    }
  } else {
    r = 255;
    g = 255;
    b = 255;
  }

  if (![r, g, b].every((v) => Number.isFinite(v))) {
    r = 255;
    g = 255;
    b = 255;
  }

  const clampedAlpha = Math.max(0, Math.min(255, Math.round(alpha)));
  const toHex = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();

  return `&H${toHex(clampedAlpha)}${toHex(b)}${toHex(g)}${toHex(r)}`;
}

/** 背景不透明度（0-100%）→ ASS alpha（0-255，语义反转：00=不透明） */
export function backOpacityToAssAlpha(backOpacity: number | undefined): number {
  const opacity = Number.isFinite(backOpacity)
    ? Math.max(0, Math.min(100, backOpacity as number))
    : DEFAULT_BACK_OPACITY;
  return Math.round((1 - opacity / 100) * 255);
}

/**
 * 生成 [V4+ Styles] 的 Style 行。
 *
 * 颜色映射按 libass 实际取色语义（背景色 bug 的修复核心）：
 * - BorderStyle=3（背景框）：背景框由 OutlineColour 绘制、阴影区由 BackColour 绘制，
 *   两者均取用户背景色 + 用户不透明度（阴影同色，避免 shadow>0 时露出异色边）；
 *   Outline 数值即背景框 padding。该模式 libass 不绘制文字描边，描边色字段被占用无感知损失。
 * - BorderStyle=1（边框+阴影）：OutlineColour 取描边色（不透明），
 *   BackColour 取背景/阴影色 + 用户不透明度。
 */
export function buildAssStyleLine(style: SubtitleStyle): string {
  const assAlpha = backOpacityToAssAlpha(style.backOpacity);
  const isBoxMode = style.borderStyle === 3;

  const primaryColour = cssColorToAss(style.primaryColor);
  const outlineColour = isBoxMode
    ? cssColorToAss(style.backColor, assAlpha)
    : cssColorToAss(style.outlineColor);
  const backColour = cssColorToAss(style.backColor, assAlpha);

  // libass 仅在 border > 0 时绘制背景框（框 = 描边区域画成实心矩形）。
  // 背景框模式下 Outline 语义是框的 padding，钳到最小 1，
  // 避免「选了背景框但边框宽度为 0 → 完全看不到框」的困惑。
  const effectiveOutline = isBoxMode
    ? Math.max(style.outline, 1)
    : style.outline;
  // 背景框模式下 Shadow 会画出一个同色偏移的「影子框」（双重边缘观感），
  // UI 在该模式下不提供阴影设置，生成端同步钳 0，保证所配即所得。
  const effectiveShadow = isBoxMode ? 0 : style.shadow;

  // Style 行是逗号分隔的定长 CSV，字体名含逗号/换行会让后续字段整体错位、
  // libass 静默错渲。ASS 无转义语法，只能剥离（字体族名本身不含这些字符）。
  const safeFontName = style.fontName.replace(/[,\r\n]/g, ' ').trim();

  const fields = [
    'Default', // Name
    safeFontName, // Fontname
    String(style.fontSize), // Fontsize
    primaryColour, // PrimaryColour
    '&H000000FF', // SecondaryColour（卡拉OK用，不涉及）
    outlineColour, // OutlineColour
    backColour, // BackColour
    style.bold ? '-1' : '0', // Bold
    style.italic ? '-1' : '0', // Italic
    style.underline ? '-1' : '0', // Underline
    '0', // StrikeOut
    '100', // ScaleX
    '100', // ScaleY
    '0', // Spacing
    '0', // Angle
    String(style.borderStyle), // BorderStyle
    String(effectiveOutline), // Outline
    String(effectiveShadow), // Shadow
    String(convertAlignment(style.alignment)), // Alignment
    String(style.marginL), // MarginL
    String(style.marginR), // MarginR
    String(style.marginV), // MarginV
    '1', // Encoding
  ];

  return `Style: ${fields.join(',')}`;
}

/** ASS Dialogue 文本转义：换行转 \N，剥离可能干扰解析的花括号覆盖标签起始符 */
function escapeAssText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\{/g, '｛') // 全角替换，避免被解析为覆盖标签
    .replace(/\}/g, '｝')
    .replace(/\n/g, '\\N');
}

/**
 * 生成完整 ASS 文档（Script Info + Styles + Events）。
 * 烧录与预览共用此函数，保证两端渲染输入一致。
 */
export function buildAssDocument(
  cues: SubtitleCue[],
  style: SubtitleStyle,
): string {
  const header = `[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayResX: ${ASS_PLAY_RES_X}
PlayResY: ${ASS_PLAY_RES_Y}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${buildAssStyleLine(style)}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = cues
    .filter((cue) => cue.text.trim() !== '' && cue.endMs > cue.startMs)
    .map(
      (cue) =>
        `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(
          cue.endMs,
        )},Default,,0,0,0,,${escapeAssText(cue.text)}`,
    )
    .join('\n');

  return header + events + '\n';
}
