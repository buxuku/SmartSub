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
import { subtitleTextRuns, subtitleGlow } from '../../types/subtitleAppearance';
import { parseSubtitleColor } from '../../types/subtitleColor';
import { mapAssOverrideBlocks } from '../../types/assOverrides';
import {
  ASS_PLAY_RES_X,
  ASS_PLAY_RES_Y,
  absoluteSubtitleY,
  subtitleAnchor,
} from '../../types/subtitleCanvas';

/** 烧录/预览共用的 ASS 脚本空间（与 ffmpeg 的 SRT 隐式转换一致） */
export { ASS_PLAY_RES_X, ASS_PLAY_RES_Y } from '../../types/subtitleCanvas';

/** 背景不透明度缺省值（百分比，≈旧版硬编码 alpha=128） */
export const DEFAULT_BACK_OPACITY = 50;

/**
 * 将前端 numpad 风格的 Alignment 转换为 ASS/SSA legacy Alignment。
 *
 * 前端 numpad 风格：7/8/9=上排，4/5/6=中排，1/2/3=下排（左/中/右）。
 * SSA legacy 编码（仅用于 FFmpeg force_style 的兼容接口，不用于 V4+ Style 行）：
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
  const color = parseSubtitleColor(cssColor);
  if (!color) throw new Error(`Invalid subtitle color: ${cssColor}`);
  // Color opacity and the separate background/glow opacity multiply.
  const opacity = color.opacity * (1 - Math.max(0, Math.min(255, alpha)) / 255);
  const clampedAlpha = Math.round((1 - opacity) * 255);
  const toHex = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();

  return `&H${toHex(clampedAlpha)}${toHex(color.blue)}${toHex(color.green)}${toHex(color.red)}`;
}

export function assPrimaryColorTags(color: string): string {
  const ass = cssColorToAss(color);
  // Override colors use BGR; unlike style colors, their alpha is a separate tag.
  return `{\\1c&H${ass.slice(4)}&\\1a&H${ass.slice(2, 4)}&}`;
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
    String(style.alignment), // V4+ uses numpad alignment directly.
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

export function styledAssText(text: string, style: SubtitleStyle): string {
  if (
    !style.secondLineColor &&
    !style.highlightTerms?.some((term) => term.trim())
  )
    return escapeAssText(text);
  return subtitleTextRuns(text, style)
    .map((run) => `${assPrimaryColorTags(run.color)}${escapeAssText(run.text)}`)
    .join('');
}

export function assGlowTags(style: SubtitleStyle): string {
  const glow = subtitleGlow(style);
  const color = cssColorToAss(style.glowColor || '#FFFFFF', 96);
  return glow
    ? `{\\1a&HFF&\\3c&H${color.slice(4)}&\\3a&H${color.slice(2, 4)}&\\bord${style.outline + glow}\\blur${glow}\\shad0}`
    : '';
}

export function assGlowText(text: string, style: SubtitleStyle): string {
  const tags = assGlowTags(style);
  return (
    tags +
    mapAssOverrideBlocks(text, (tag) => {
      if (tag.startsWith('\\r')) return `${tag}${tags.slice(1, -1)}`;
      if (/^\\1a(?:&|$)/.test(tag)) return '\\1a&HFF&';
      if (/^\\alpha(?:&|$)/.test(tag)) return `${tag}\\1a&HFF&`;
      return tag;
    })
  );
}

/**
 * 生成完整 ASS 文档（Script Info + Styles + Events）。
 * 烧录与预览共用此函数，保证两端渲染输入一致。
 */
export function buildAssDocument(
  cues: SubtitleCue[],
  style: SubtitleStyle,
): string {
  const anchor = subtitleAnchor(style);
  const position =
    absoluteSubtitleY(style) === undefined
      ? ''
      : `{\\an${style.alignment}\\pos(${Number(anchor.x.toFixed(3))},${Number(anchor.y.toFixed(3))})}`;
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
    .flatMap((cue) => {
      const timing = `${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},Default,,0,0,0,,`;
      const text = styledAssText(cue.text, style);
      const glow = assGlowTags(style);
      return glow
        ? [
            `Dialogue: 0,${timing}${position}${assGlowText(text, style)}`,
            `Dialogue: 1,${timing}${position}${text}`,
          ]
        : [`Dialogue: 0,${timing}${position}${text}`];
    })
    .join('\n');

  return header + events + '\n';
}
