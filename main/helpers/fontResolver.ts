/**
 * 字体解析模块：
 *   1. 烧录/预览共用的 CJK 字体兜底（从 subtitleMerger 抽出，供 ASS 生成与预览 IPC 复用）；
 *   2. 按字体名解析本机字体文件（供 JASSUB WASM 预览加载真实字形）。
 */

import * as fs from 'fs';
import * as path from 'path';

// 纯拉丁字体（不含 CJK 字形）。中文字幕若用这些字体烧录，libass 找不到字形会渲染成
// 豆腐块/乱码（issue: mac 中文烧录乱码）。命中且字幕含 CJK 时回退到平台 CJK 字体。
const LATIN_ONLY_FONTS = new Set([
  'arial',
  'helvetica',
  'helvetica neue',
  'georgia',
  'times new roman',
  'verdana',
  'roboto',
  'impact',
  'tahoma',
  'courier new',
]);

/** 文本是否包含 CJK（中日韩）字符 */
export function containsCJK(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(
    text,
  );
}

/** 选中字体是否为纯拉丁字体（无 CJK 字形） */
export function isLatinOnlyFont(fontName: string): boolean {
  return LATIN_ONLY_FONTS.has((fontName || '').trim().toLowerCase());
}

/**
 * macOS 上「确有字体文件」的常见 CJK 字体（按优先级）。
 * 关键点：PingFang 在部分 macOS 上没有可被 fontconfig 索引的字体文件
 * （仅 CoreText 可见），libass 解析「PingFang SC」会回退到 Helvetica → 中文渲染成乱码。
 * 因此烧录前必须挑一个「文件确实存在」的 CJK 字体，按 family 名交给 libass。
 * family 名取自 libass/fontconfig 对相应文件的实际解析结果（已实测）。
 */
const MAC_CJK_FONTS: Array<{ name: string; files: string[] }> = [
  { name: 'PingFang SC', files: ['/System/Library/Fonts/PingFang.ttc'] },
  {
    name: 'Hiragino Sans GB',
    files: ['/System/Library/Fonts/Hiragino Sans GB.ttc'],
  },
  {
    name: 'Heiti SC',
    files: [
      '/System/Library/Fonts/STHeiti Medium.ttc',
      '/System/Library/Fonts/STHeiti Light.ttc',
    ],
  },
  {
    name: 'Songti SC',
    files: ['/System/Library/Fonts/Supplemental/Songti.ttc'],
  },
  {
    name: 'Arial Unicode MS',
    files: ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf'],
  },
];

let cachedMacCJKFont: string | null = null;

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** macOS：返回第一个字体文件确实存在的 CJK 字体名（结果缓存） */
export function resolveMacCJKFont(): string {
  if (cachedMacCJKFont) return cachedMacCJKFont;
  const found = MAC_CJK_FONTS.find((f) => f.files.some(fileExists));
  cachedMacCJKFont = found?.name ?? 'Arial Unicode MS';
  return cachedMacCJKFont;
}

/** 该字体在 macOS 上是否为「文件存在」的已知 CJK 字体（可被 libass 正常解析） */
export function isMacResolvableCJKFont(fontName: string): boolean {
  const norm = (fontName || '').trim().toLowerCase();
  const matched = MAC_CJK_FONTS.find((f) => f.name.toLowerCase() === norm);
  return Boolean(matched && matched.files.some(fileExists));
}

/** 按运行平台返回一个稳定可用的 CJK 字体名 */
export function getPlatformCJKFont(): string {
  switch (process.platform) {
    case 'darwin':
      return resolveMacCJKFont();
    case 'win32':
      return 'Microsoft YaHei';
    default:
      return 'Noto Sans CJK SC';
  }
}

/**
 * 为「含 CJK 的字幕」决定最终烧录字体：
 * - 不含 CJK：原样使用用户所选字体；
 * - macOS：所选字体若不是「文件存在的已知 CJK 字体」（含用户默认 PingFang 在本机缺失的情况），
 *   一律换成 resolveMacCJKFont() 解析出的可用 CJK 字体；
 * - 其它平台：仅当所选为纯拉丁字体时回退到平台 CJK 字体。
 */
export function resolveBurnFontName(
  chosenFont: string,
  hasCJK: boolean,
): string {
  if (!hasCJK) return chosenFont;
  if (process.platform === 'darwin') {
    return isMacResolvableCJKFont(chosenFont)
      ? chosenFont
      : resolveMacCJKFont();
  }
  return isLatinOnlyFont(chosenFont) ? getPlatformCJKFont() : chosenFont;
}

// ----------------------------- 字体文件解析（预览用） -----------------------------

/** Windows 常见字体名 → 系统字体文件名映射 */
const WIN_FONT_FILES: Record<string, string[]> = {
  'microsoft yahei': ['msyh.ttc', 'msyh.ttf'],
  simhei: ['simhei.ttf'],
  simsun: ['simsun.ttc'],
  kaiti: ['simkai.ttf'],
  arial: ['arial.ttf'],
  verdana: ['verdana.ttf'],
  georgia: ['georgia.ttf'],
  'times new roman': ['times.ttf'],
  impact: ['impact.ttf'],
  tahoma: ['tahoma.ttf'],
  'courier new': ['cour.ttf'],
};

/** macOS 常见拉丁字体名 → 字体文件路径映射（Supplemental 目录） */
const MAC_LATIN_FONT_FILES: Record<string, string[]> = {
  arial: ['/System/Library/Fonts/Supplemental/Arial.ttf'],
  helvetica: ['/System/Library/Fonts/Helvetica.ttc'],
  'helvetica neue': ['/System/Library/Fonts/HelveticaNeue.ttc'],
  georgia: ['/System/Library/Fonts/Supplemental/Georgia.ttf'],
  'times new roman': ['/System/Library/Fonts/Supplemental/Times New Roman.ttf'],
  verdana: ['/System/Library/Fonts/Supplemental/Verdana.ttf'],
  impact: ['/System/Library/Fonts/Supplemental/Impact.ttf'],
  tahoma: ['/System/Library/Fonts/Supplemental/Tahoma.ttf'],
  'courier new': ['/System/Library/Fonts/Supplemental/Courier New.ttf'],
};

/** Linux 常见 CJK/通用字体文件搜索路径 */
const LINUX_FONT_CANDIDATES: Record<string, string[]> = {
  'noto sans cjk sc': [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  ],
  'noto sans sc': [
    '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  ],
};

/**
 * 按字体名解析本机字体文件路径。
 * 返回 null 表示无法定位（调用方应回退到平台 CJK 字体）。
 */
export function resolveFontFilePath(fontName: string): string | null {
  const norm = (fontName || '').trim().toLowerCase();
  if (!norm) return null;

  if (process.platform === 'darwin') {
    const cjk = MAC_CJK_FONTS.find((f) => f.name.toLowerCase() === norm);
    if (cjk) {
      const file = cjk.files.find(fileExists);
      if (file) return file;
    }
    const latinFiles = MAC_LATIN_FONT_FILES[norm];
    return latinFiles?.find(fileExists) ?? null;
  }

  if (process.platform === 'win32') {
    const fontsDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
    const files = WIN_FONT_FILES[norm];
    if (!files) return null;
    const found = files.map((f) => path.join(fontsDir, f)).find(fileExists);
    return found ?? null;
  }

  const linuxFiles = LINUX_FONT_CANDIDATES[norm];
  return linuxFiles?.find(fileExists) ?? null;
}

export interface ResolvedFontData {
  /** 实际解析到的字体 family 名（可能是兜底字体） */
  fontName: string;
  /** 字体文件路径 */
  filePath: string;
  /** 字体文件内容 */
  data: Buffer;
}

/**
 * 预览专用 CJK 兜底字体（按平台，必须是单面 TTF/OTF）。
 * 实测 JASSUB（libass WASM）的内存字体加载对 .ttc 集合文件无效
 * （注册后 fontselect 找不到 family），因此预览侧只能喂单面字体文件。
 * 烧录侧不受影响（fontconfig 按 family 名解析系统字体，支持 ttc）。
 */
const PREVIEW_CJK_FALLBACKS: Array<{ name: string; files: string[] }> =
  process.platform === 'darwin'
    ? [
        {
          name: 'Arial Unicode MS',
          files: ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf'],
        },
      ]
    : process.platform === 'win32'
      ? [
          {
            name: 'SimHei',
            files: [
              path.join(
                process.env.WINDIR || 'C:\\Windows',
                'Fonts',
                'simhei.ttf',
              ),
            ],
          },
        ]
      : [
          {
            name: 'Noto Sans SC',
            files: [
              '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
              '/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf',
            ],
          },
        ];

/** JASSUB 内存字体无法解析 .ttc 集合文件，预览侧跳过 */
function isPreviewLoadableFontFile(filePath: string): boolean {
  return !filePath.toLowerCase().endsWith('.ttc');
}

/**
 * 解析字体名对应的字体文件数据（供 JASSUB WASM 预览加载）。
 * 所选字体无法定位或为 .ttc 集合文件时，回退到平台预览兜底字体（单面 TTF/OTF）。
 * 全部失败时返回 null（渲染层降级到 CSS 预览）。
 */
export function loadFontData(fontName: string): ResolvedFontData | null {
  const tryLoadFile = (
    name: string,
    filePath: string | null,
  ): ResolvedFontData | null => {
    if (!filePath || !isPreviewLoadableFontFile(filePath)) return null;
    try {
      return { fontName: name, filePath, data: fs.readFileSync(filePath) };
    } catch {
      return null;
    }
  };

  const direct = tryLoadFile(fontName, resolveFontFilePath(fontName));
  if (direct) return direct;

  for (const fallback of PREVIEW_CJK_FALLBACKS) {
    const file = fallback.files.find(fileExists);
    const loaded = tryLoadFile(fallback.name, file ?? null);
    if (loaded) return loaded;
  }
  return null;
}
