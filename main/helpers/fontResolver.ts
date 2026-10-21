import * as fs from 'fs';
import * as path from 'path';
import * as fontkit from 'fontkit';
import * as os from 'os';
import { readAssEmbeddedFonts } from './assEmbeddedFonts';
import type { FontFallbackSummary } from '../../types/subtitleMerge';
import { commonFontRank } from './commonFonts';

export type { FontFallbackSummary };

const MAC_FONTS: Record<string, string[]> = {
  'PingFang SC': ['/System/Library/Fonts/PingFang.ttc'],
  'Hiragino Sans GB': ['/System/Library/Fonts/Hiragino Sans GB.ttc'],
  'Heiti SC': ['/System/Library/Fonts/STHeiti Medium.ttc'],
  'Songti SC': ['/System/Library/Fonts/Supplemental/Songti.ttc'],
  'Apple SD Gothic Neo': ['/System/Library/Fonts/AppleSDGothicNeo.ttc'],
  AppleGothic: ['/System/Library/Fonts/Supplemental/AppleGothic.ttf'],
  'Arial Unicode MS': ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf'],
  Helvetica: ['/System/Library/Fonts/Helvetica.ttc'],
  'Helvetica Neue': ['/System/Library/Fonts/HelveticaNeue.ttc'],
  ...Object.fromEntries(
    [
      'Arial',
      'Georgia',
      'Times New Roman',
      'Verdana',
      'Impact',
      'Tahoma',
      'Courier New',
    ].map((name) => [name, [`/System/Library/Fonts/Supplemental/${name}.ttf`]]),
  ),
};
const WINDOWS_FONTS: Record<string, string[]> = Object.fromEntries(
  Object.entries({
    'Microsoft YaHei': ['msyh.ttc', 'msyh.ttf'],
    SimHei: ['simhei.ttf'],
    SimSun: ['simsun.ttc'],
    KaiTi: ['simkai.ttf'],
    'Malgun Gothic': ['malgun.ttf'],
    'Yu Gothic': ['YuGothR.ttc', 'YuGothM.ttc'],
    Meiryo: ['meiryo.ttc'],
    'Microsoft JhengHei': ['msjh.ttc', 'msjh.ttf'],
    'MS Gothic': ['msgothic.ttc'],
    'Segoe UI': ['segoeui.ttf'],
    'Segoe UI Symbol': ['seguisym.ttf'],
    'Leelawadee UI': ['LeelawUI.ttf'],
    Arial: ['arial.ttf'],
    Verdana: ['verdana.ttf'],
    Georgia: ['georgia.ttf'],
    'Times New Roman': ['times.ttf'],
    Impact: ['impact.ttf'],
    Tahoma: ['tahoma.ttf'],
    'Courier New': ['cour.ttf'],
  }).map(([name, files]) => [
    name,
    files.map((file) =>
      path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', file),
    ),
  ]),
);
const LINUX_FONTS: Record<string, string[]> = {
  'DejaVu Sans': ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
  'DejaVu Sans Mono': ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'],
  'Liberation Sans': [
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ],
  'Liberation Mono': [
    '/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
  ],
  'Noto Sans CJK SC': [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  ],
  'Noto Sans CJK KR': [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  ],
  'Noto Sans CJK JP': [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  ],
  'Noto Sans CJK TC': [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  ],
  'Noto Sans SC': [
    '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf',
  ],
  'Noto Sans KR': [
    '/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansKR-Regular.otf',
  ],
  'Noto Sans JP': [
    '/usr/share/fonts/truetype/noto/NotoSansJP-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansJP-Regular.otf',
  ],
  NanumGothic: ['/usr/share/fonts/truetype/nanum/NanumGothic.ttf'],
  'WenQuanYi Micro Hei': ['/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'],
};

interface FontFaceInfo {
  familyName: string;
  subfamilyName: string;
  postscriptName: string;
  fullName: string;
  hasGlyphForCodePoint(code: number): boolean;
  name?: {
    records?: {
      preferredFamily?: Record<string, string>;
      fontFamily?: Record<string, string>;
    };
  };
}
interface FontRecord {
  fontName: string;
  filePath: string;
  face: FontFaceInfo;
  data?: Buffer;
  id?: string;
}
export type FontContext = readonly FontRecord[];
const faceNames = (face: FontFaceInfo) =>
  [
    face.familyName,
    face.fullName,
    face.postscriptName,
    ...Object.values(face.name?.records?.preferredFamily || {}),
  ].filter(Boolean);

export function embeddedFontContext(content: string): FontContext {
  return readAssEmbeddedFonts(content).flatMap((entry) => {
    try {
      const font = fontkit.create(entry.data);
      const faces: FontFaceInfo[] = font.fonts || [font];
      if (!faces.length || faces.some((face) => !face.familyName))
        throw new Error('Missing font family');
      if (faces.some((face) => /[{}\\,\r\n]/.test(face.familyName)))
        throw new Error('Invalid ASS font family');
      return faces.map((face) => ({
        fontName: face.familyName,
        filePath: '',
        face,
        data: entry.data,
        id: entry.id,
      }));
    } catch (cause) {
      throw new Error(
        `Invalid ASS embedded font ${entry.name}: ${String(cause)}`,
      );
    }
  });
}
const records = new Map<
  string,
  { stamp: string; size: number; faces: FontFaceInfo[] }
>();
const aliases = new Map<string, string>();
const installedFamilies = new Map<string, Set<string>>();
const catalog = new Map<string, { stamp: string; faces: FontFaceInfo[] }>();
const MAX_SCANNED_FONT_FILES = 20000;
const SAMPLE_TEXT = 'SmartSub 字幕示例 123';
const yieldToApp = () => new Promise<void>((resolve) => setImmediate(resolve));
let discovery: Promise<void> | undefined;
let cachedBytes = 0;
let scannedAt = 0;
const normalize = (value: string) => value.trim().toLowerCase();
const candidates =
  process.platform === 'darwin'
    ? MAC_FONTS
    : process.platform === 'win32'
      ? WINDOWS_FONTS
      : LINUX_FONTS;

function registerFaces(filePath: string, faces: FontFaceInfo[]) {
  for (const face of faces) {
    if (!face.familyName || face.familyName.startsWith('.')) continue;
    for (const name of faceNames(face)) {
      const key = normalize(name);
      if (
        !aliases.has(key) ||
        /^(regular|normal|book|roman)$/i.test(face.subfamilyName)
      )
        aliases.set(key, filePath);
    }
    const family = installedFamilies.get(face.familyName) || new Set<string>();
    family.add(filePath);
    installedFamilies.set(face.familyName, family);
  }
}

function rememberFont(
  filePath: string,
  stamp: string,
  size: number,
  faces: FontFaceInfo[],
) {
  const previous = records.get(filePath);
  if (previous) {
    records.delete(filePath);
    cachedBytes -= previous.size;
  }
  if (size <= 64 * 1024 * 1024) {
    while (
      records.size &&
      (records.size >= 32 || cachedBytes + size > 64 * 1024 * 1024)
    ) {
      const [key, oldest] = records.entries().next().value!;
      records.delete(key);
      cachedBytes -= oldest.size;
    }
    records.set(filePath, { stamp, size, faces });
    cachedBytes += size;
  }
  registerFaces(filePath, faces);
}

function readFaces(filePath: string): FontFaceInfo[] {
  const stat = fs.statSync(filePath);
  const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ctimeMs}`;
  const cached = records.get(filePath);
  if (cached?.stamp === stamp) {
    records.delete(filePath);
    records.set(filePath, cached);
    return cached.faces;
  }
  const font = fontkit.openSync(filePath);
  const faces: FontFaceInfo[] = font.fonts || [font];
  rememberFont(filePath, stamp, stat.size, faces);
  return faces;
}

/** Coalesce discovery and yield between font files; never scan a library on a sync lookup. */
export async function prepareSubtitleFonts(force = false): Promise<void> {
  if (discovery) return discovery;
  if (!force && scannedAt && Date.now() - scannedAt < 30000) return;
  discovery = discoverInstalledFonts().finally(() => {
    discovery = undefined;
  });
  return discovery;
}

async function discoverInstalledFonts() {
  const roots =
    process.platform === 'darwin'
      ? [
          '/System/Library/Fonts',
          '/Library/Fonts',
          path.join(os.homedir(), 'Library/Fonts'),
        ]
      : process.platform === 'win32'
        ? [
            path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
            path.join(
              process.env.LOCALAPPDATA ||
                path.join(os.homedir(), 'AppData/Local'),
              'Microsoft/Windows/Fonts',
            ),
          ]
        : [
            '/usr/share/fonts',
            '/usr/local/share/fonts',
            path.join(os.homedir(), '.fonts'),
            path.join(
              process.env.XDG_DATA_HOME ||
                path.join(os.homedir(), '.local/share'),
              'fonts',
            ),
          ];
  let count = 0;
  const next = new Map<string, { stamp: string; faces: FontFaceInfo[] }>();
  const visit = async (directory: string, depth: number) => {
    if (depth > 8 || count >= MAX_SCANNED_FONT_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile() && /\.(ttf|otf|ttc|otc)$/i.test(entry.name)) {
        if (++count > MAX_SCANNED_FONT_FILES) return;
        try {
          const stat = await fs.promises.stat(file);
          const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ctimeMs}`;
          const previous = catalog.get(file);
          if (previous?.stamp === stamp) {
            next.set(file, previous);
            continue;
          }
          if (stat.size > 64 * 1024 * 1024) continue;
          const font = fontkit.create(await fs.promises.readFile(file));
          const faces: FontFaceInfo[] = font.fonts || [font];
          // Keep lightweight names/sample coverage, not thousands of font buffers.
          const metadata = faces.map((face) => {
            const codes = new Set(
              Array.from(SAMPLE_TEXT)
                .map((c) => c.codePointAt(0)!)
                .filter((code) => face.hasGlyphForCodePoint(code)),
            );
            return {
              familyName: face.familyName,
              fullName: face.fullName,
              postscriptName: face.postscriptName,
              subfamilyName: face.subfamilyName,
              name: {
                records: {
                  preferredFamily: { ...face.name?.records?.preferredFamily },
                  fontFamily: { ...face.name?.records?.fontFamily },
                },
              },
              hasGlyphForCodePoint: (code: number) => codes.has(code),
            };
          });
          next.set(file, { stamp, faces: metadata });
        } catch {
          /* Ignore unreadable or unsupported installed fonts. */
        }
        await yieldToApp();
      }
    }
  };
  for (const root of roots) await visit(root, 0);
  aliases.clear();
  installedFamilies.clear();
  catalog.clear();
  presetFallbacks.clear();
  for (const [file, entry] of next) {
    catalog.set(file, entry);
    registerFaces(file, entry.faces);
  }
  scannedAt = Date.now();
}

export function resolveFontFilePath(fontName: string): string | null {
  const key = normalize(fontName || '');
  const cached = aliases.get(key);
  if (cached && fs.existsSync(cached)) return cached;
  const entry = Object.entries(candidates).find(
    ([name]) => normalize(name) === key,
  );
  return entry?.[1].find((file) => fs.existsSync(file)) || null;
}

function resolveFace(
  fontName: string,
  context: FontContext = [],
): FontRecord | null {
  const embedded = context.filter((font) =>
    faceNames(font.face).some(
      (name) => normalize(name) === normalize(fontName),
    ),
  );
  if (embedded.length)
    return (
      embedded.find((font) =>
        /^(regular|normal|book|roman)$/i.test(font.face.subfamilyName),
      ) || embedded[0]
    );
  let filePath = resolveFontFilePath(fontName);
  if (!filePath) {
    // Persisted resolved family names may differ from the platform's display alias.
    for (const files of Object.values(candidates)) {
      const file = files.find((file) => fs.existsSync(file));
      if (file) {
        try {
          readFaces(file);
        } catch {
          /* Skip damaged font files. */
        }
      }
    }
    filePath = resolveFontFilePath(fontName);
  }
  if (!filePath) return null;
  try {
    const key = normalize(fontName);
    const allFaces = readFaces(filePath);
    const exact = allFaces.filter(
      (face) =>
        normalize(face.fullName) === key ||
        normalize(face.postscriptName) === key,
    );
    const faces = exact.length
      ? exact
      : allFaces.filter((face) =>
          faceNames(face).some((name) => normalize(name) === key),
        );
    const face =
      faces.find((face) =>
        /^(regular|normal|book|roman)$/i.test(face.subfamilyName),
      ) || faces[0];
    return face ? { fontName: face.familyName, filePath, face } : null;
  } catch {
    return null;
  }
}

export function containsCJK(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(
    text,
  );
}

export function resolveSharedFont(
  fontName: string,
  _hasCJK = false,
  context: FontContext = [],
): FontRecord | null {
  const direct = resolveFace(fontName, context);
  if (direct) return direct;
  const fallbackNames = /courier|mono/i.test(fontName)
    ? ['Courier New', 'DejaVu Sans Mono', 'Liberation Mono']
    : /arial|helvetica|georgia|times|verdana|roboto|impact|tahoma|sans|serif/i.test(
          fontName,
        ) && !/cjk|hiragino|noto|han/i.test(fontName)
      ? ['Arial', 'DejaVu Sans', 'Liberation Sans']
      : [
          'Arial Unicode MS',
          'Heiti SC',
          'Microsoft YaHei',
          'Noto Sans CJK SC',
          'Noto Sans SC',
          'Arial',
          'DejaVu Sans',
          'Liberation Sans',
        ];
  for (const name of fallbackNames) {
    const font = resolveFace(name, context);
    if (font) return font;
  }
  return null;
}

/** Resolve the actual family stored in the font, not only its OS display alias. */
export function resolveBurnFontName(
  chosenFont: string,
  hasCJK: boolean,
  context: FontContext = [],
): string {
  const resolved = resolveSharedFont(chosenFont, hasCJK, context);
  if (!resolved)
    throw new Error(`No preview/export font available for: ${chosenFont}`);
  return resolved.fontName;
}

export interface ResolvedFontData {
  fontName: string;
  fullName: string;
  postscriptName: string;
  filePath: string;
  data: Buffer;
  variants: Buffer[];
}
export function loadFontData(
  fontName: string,
  context: FontContext = [],
): ResolvedFontData | null {
  const resolved = resolveSharedFont(fontName, false, context);
  if (!resolved) return null;
  try {
    if (resolved.data)
      return {
        fontName: resolved.fontName,
        fullName: resolved.face.fullName,
        postscriptName: resolved.face.postscriptName,
        filePath: '',
        data: resolved.data,
        variants: Array.from(
          new Set(
            context
              .filter(
                (font) =>
                  font.fontName === resolved.fontName &&
                  font.data !== resolved.data,
              )
              .map((font) => font.data!),
          ),
        ),
      };
    // Standalone families keep bold/italic faces in adjacent files. Load those
    // faces so preview does not synthesize a different weight from FFmpeg.
    const basename = path.basename(
      resolved.filePath,
      path.extname(resolved.filePath),
    );
    const siblings = Array.from(
      new Set([
        ...Array.from(installedFamilies.get(resolved.fontName) || []),
        ...(path.extname(resolved.filePath).toLowerCase() === '.ttc'
          ? []
          : fs
              .readdirSync(path.dirname(resolved.filePath))
              .filter(
                (file) =>
                  /\.(ttf|otf)$/i.test(file) &&
                  path.basename(file, path.extname(file)).startsWith(basename),
              )
              .map((file) => path.join(path.dirname(resolved.filePath), file))),
      ]),
    ).filter((file) => {
      if (file === resolved.filePath) return false;
      try {
        return readFaces(file).some(
          (face) => face.familyName === resolved.fontName,
        );
      } catch {
        return false;
      }
    });
    return {
      fontName: resolved.fontName,
      fullName: resolved.face.fullName,
      postscriptName: resolved.face.postscriptName,
      filePath: resolved.filePath,
      data: fs.readFileSync(resolved.filePath),
      variants: siblings.map((file) => fs.readFileSync(file)),
    };
  } catch {
    return null;
  }
}

/**
 * System fonts tried (in order) for glyphs the requested font lacks. The first
 * entries keep the historical order so already-covered text renders unchanged.
 */
export const FALLBACK_FONT_NAMES = [
  'Arial Unicode MS',
  'Heiti SC',
  'Microsoft YaHei',
  'Noto Sans CJK SC',
  'Noto Sans SC',
  'SimHei',
  'DejaVu Sans',
  'PingFang SC',
  'Apple SD Gothic Neo',
  'AppleGothic',
  'Hiragino Sans',
  'Malgun Gothic',
  'Yu Gothic',
  'Meiryo',
  'Microsoft JhengHei',
  'MS Gothic',
  'Noto Sans CJK KR',
  'Noto Sans CJK JP',
  'Noto Sans CJK TC',
  'Noto Sans KR',
  'Noto Sans JP',
  'NanumGothic',
  'WenQuanYi Micro Hei',
  'Leelawadee UI',
  'Thonburi',
  'Segoe UI Symbol',
  'Segoe UI',
  'Liberation Sans',
];
const fallbackNames = (context: FontContext) => [
  ...context.map((font) => font.fontName),
  ...FALLBACK_FONT_NAMES,
];
/** Zero-width and variation characters never draw a glyph, so they are not "missing". */
const INVISIBLE_CHARACTER =
  /[\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff\u{e0100}-\u{e01ef}]/u;
const hasAllGlyphs = (font: FontRecord | null, codes: number[]) =>
  Boolean(font) && codes.every((code) => font!.face.hasGlyphForCodePoint(code));

export interface FontFallbackReport {
  fallbacks: Map<string, { from: string; to: string; sample: string }>;
  missing: Set<string>;
}
export const newFontFallbackReport = (): FontFallbackReport => ({
  fallbacks: new Map(),
  missing: new Set(),
});
export function summarizeFontFallbackReport(
  report: FontFallbackReport,
): FontFallbackSummary {
  return {
    fallbacks: Array.from(report.fallbacks.values()),
    missingGlyphs: Array.from(report.missing).slice(0, 50),
  };
}
function noteFallback(
  report: FontFallbackReport | undefined,
  from: string,
  to: string,
  character: string,
) {
  if (!report) return;
  const key = `${from}\u0000${to}`;
  const entry = report.fallbacks.get(key) || { from, to, sample: '' };
  if (entry.sample.length < 8 && !entry.sample.includes(character))
    entry.sample += character;
  report.fallbacks.set(key, entry);
}

// Resolved per-code-point fallbacks; only valid without document-embedded fonts.
const presetFallbacks = new Map<number, string | null>();

function presetFallbackFont(
  codes: number[],
  context: FontContext,
): FontRecord | null {
  const cacheable = !context.length && codes.length === 1;
  if (cacheable && presetFallbacks.has(codes[0])) {
    const name = presetFallbacks.get(codes[0]);
    return name ? resolveFace(name) : null;
  }
  let found: FontRecord | null = null;
  for (const name of fallbackNames(context)) {
    // resolveFace rescans every known font for unknown names; skip absent ones.
    if (
      !context.some((font) => font.fontName === name) &&
      !resolveFontFilePath(name)
    )
      continue;
    const font = resolveFace(name, context);
    if (hasAllGlyphs(font, codes)) {
      found = font;
      break;
    }
  }
  if (cacheable) presetFallbacks.set(codes[0], found?.fontName ?? null);
  return found;
}

const LIKELY_COVERAGE_NAME =
  /cjk|gothic|malgun|nanum|gulim|batang|hei|ming|song|yahei|jheng|mincho|meiryo|unicode|noto|sans|hangul|korean|japan/i;

/**
 * One preset font covering every missing code point, so a line keeps a single
 * fallback look. Installed fonts are deliberately not searched here: swapping
 * in an arbitrary system font is an effect the user did not choose. Such text
 * is reported instead, together with recommended fonts to pick explicitly.
 */
function coveringFont(codes: number[], context: FontContext) {
  return presetFallbackFont(codes, context);
}

/**
 * Split text into runs of the requested font and explicit per-glyph fallbacks.
 * Glyphs no installed font provides stay on the requested font (drawn as
 * boxes) and are recorded in `report` instead of failing preview or export.
 */
export function fontTextRuns(
  text: string,
  fontName: string,
  context: FontContext = [],
  report?: FontFallbackReport,
): Array<{ text: string; fontName: string }> {
  const primary = resolveFace(fontName, context);
  const covered = (code: number) =>
    code < 32 || Boolean(primary?.face.hasGlyphForCodePoint(code));
  const missing = Array.from(
    new Set(
      Array.from(text)
        .filter((char) => !INVISIBLE_CHARACTER.test(char))
        .map((char) => char.codePointAt(0)!),
    ),
  ).filter((code) => !covered(code));
  if (!missing.length) return [{ text, fontName }];
  const single = coveringFont(missing, context);
  const perCharacter = new Map<number, FontRecord | null>();
  const fallbackFor = (code: number) => {
    if (single) return single;
    if (!perCharacter.has(code))
      perCharacter.set(code, presetFallbackFont([code], context));
    return perCharacter.get(code)!;
  };
  const runs: Array<{ text: string; fontName: string }> = [];
  for (const character of Array.from(text)) {
    const code = character.codePointAt(0)!;
    let name = fontName;
    // Invisible characters draw nothing, so they stay on the requested font.
    if (!covered(code) && !INVISIBLE_CHARACTER.test(character)) {
      const fallback = fallbackFor(code);
      if (fallback) {
        name = fallback.fontName;
        noteFallback(report, fontName, name, character);
      } else report?.missing.add(character);
    }
    const last = runs[runs.length - 1];
    if (last?.fontName === name) last.text += character;
    else runs.push({ text: character, fontName: name });
  }
  return runs;
}

export interface FontRecommendation {
  name: string;
  displayName?: string;
}
const MAX_RECOMMENDATION_CODES = 3000;

/**
 * Installed fonts that render all of `text` without any fallback, most common
 * first. Runs asynchronously (yielding to the app) and within `budgetMs`; a
 * truncated search reports `complete: false` and caches nothing.
 */
export async function recommendFontsForText(
  text: string,
  context: FontContext = [],
  options: { exclude?: string; limit?: number; budgetMs?: number } = {},
): Promise<{ fonts: FontRecommendation[]; complete: boolean }> {
  const { exclude, limit = 5, budgetMs = 2500 } = options;
  const codes = Array.from(
    new Set(
      Array.from(text)
        .filter((char) => !/\s/.test(char) && !INVISIBLE_CHARACTER.test(char))
        .map((char) => char.codePointAt(0)!)
        .filter((code) => code >= 32),
    ),
  ).slice(0, MAX_RECOMMENDATION_CODES);
  if (!codes.length) return { fonts: [], complete: true };
  await prepareSubtitleFonts();
  const excluded = normalize(exclude || '');
  const rankOf = (name: string) => commonFontRank([name]) ?? Infinity;
  const names = Array.from(
    new Set([
      ...context.map((font) => font.fontName),
      ...Array.from(installedFamilies.keys()),
    ]),
  )
    .filter(
      (name) => name && !name.startsWith('.') && normalize(name) !== excluded,
    )
    .sort(
      (a, b) =>
        Number(context.some((font) => font.fontName === b)) -
          Number(context.some((font) => font.fontName === a)) ||
        rankOf(a) - rankOf(b) ||
        Number(LIKELY_COVERAGE_NAME.test(b)) -
          Number(LIKELY_COVERAGE_NAME.test(a)) ||
        a.localeCompare(b),
    );
  const deadline = Date.now() + budgetMs;
  const fonts: FontRecommendation[] = [];
  let checked = 0;
  for (const name of names) {
    if (fonts.length >= limit) break;
    if (Date.now() >= deadline) return { fonts, complete: false };
    if (++checked % 4 === 0) await yieldToApp();
    // Same lookup as preview and export, so a recommendation really needs no fallback.
    const font = resolveFace(name, context);
    if (!font || !hasAllGlyphs(font, codes)) continue;
    if (fonts.some((item) => item.name === font.fontName)) continue;
    fonts.push({
      name: font.fontName,
      displayName: localizedFamilyNames(font.face).displayName,
    });
  }
  return { fonts, complete: true };
}

const DISPLAY_LANGUAGE_ORDER = [
  'zh',
  'zh-CN',
  'zh-Hans',
  'zh-TW',
  'zh-Hant',
  'zh-HK',
  'ja',
  'ko',
];
/** Localized family names (e.g. 苹方-简) plus the preferred display one. */
export function localizedFamilyNames(face: FontFaceInfo): {
  displayName?: string;
  localizedNames: string[];
} {
  const records = [
    face.name?.records?.preferredFamily,
    face.name?.records?.fontFamily,
  ].filter(Boolean) as Record<string, string>[];
  const english = normalize(face.familyName || '');
  const localizedNames = Array.from(
    new Set(
      records
        .flatMap((record) => Object.values(record))
        .filter((name) => name && normalize(name) !== english),
    ),
  );
  for (const language of DISPLAY_LANGUAGE_ORDER)
    for (const record of records) {
      const name = record[language];
      if (name && normalize(name) !== english)
        return { displayName: name, localizedNames };
    }
  return { localizedNames };
}

export async function listSubtitleFonts(context: FontContext = []) {
  await prepareSubtitleFonts();
  const listedFace = (name: string): FontRecord | null => {
    const key = normalize(name);
    const embedded = context.find((font) =>
      faceNames(font.face).some((name) => normalize(name) === key),
    );
    if (embedded) return embedded;
    const filePath = resolveFontFilePath(name);
    if (!filePath) return null;
    const faces = catalog.get(filePath)?.faces;
    const matches = faces?.filter((face) =>
      faceNames(face).some((name) => normalize(name) === key),
    );
    const face =
      matches?.find((face) =>
        /^(regular|normal|book|roman)$/i.test(face.subfamilyName),
      ) || matches?.[0];
    return face
      ? { fontName: face.familyName, face, filePath }
      : resolveFace(name);
  };
  const names = Array.from(
    new Set([
      ...Object.keys(candidates),
      ...context.map((font) => font.fontName),
      ...Array.from(installedFamilies.keys()),
    ]),
  );
  const options = [];
  // Fallbacks are shared by every listed font: resolve each at most once.
  const sampleFallbackNames = fallbackNames(context);
  const sampleFaces = new Map<string, FontRecord | null>();
  const sampleFace = (name: string) => {
    if (!sampleFaces.has(name)) sampleFaces.set(name, listedFace(name));
    return sampleFaces.get(name)!;
  };
  const sampleFallback = (missing: string[]) => {
    for (const name of sampleFallbackNames) {
      const face = sampleFace(name);
      if (
        face &&
        missing.every((char) =>
          face.face.hasGlyphForCodePoint(char.codePointAt(0)!),
        )
      )
        return face;
    }
    return undefined;
  };
  for (const name of names) {
    const font = listedFace(name);
    let sampleRuns: Array<{
      text: string;
      fontName: string;
      fullName?: string;
      postscriptName?: string;
    }> = [];
    if (font) {
      try {
        const missing = Array.from(SAMPLE_TEXT).filter(
          (char) => !font.face.hasGlyphForCodePoint(char.codePointAt(0)!),
        );
        const fallback = missing.length ? sampleFallback(missing) : font;
        if (!fallback) throw new Error('No sample fallback');
        for (const char of Array.from(SAMPLE_TEXT)) {
          const selected = font.face.hasGlyphForCodePoint(char.codePointAt(0)!)
            ? font
            : fallback;
          const last = sampleRuns.at(-1);
          if (last?.fontName === selected.fontName) last.text += char;
          else
            sampleRuns.push({
              text: char,
              fontName: selected.fontName,
              fullName: selected.data ? undefined : selected.face.fullName,
              postscriptName: selected.data
                ? undefined
                : selected.face.postscriptName,
            });
        }
      } catch {
        /* A Latin-only installation can still select Latin fonts. */
      }
    }
    const localized = font
      ? localizedFamilyNames(font.face)
      : { localizedNames: [] as string[] };
    options.push({
      name,
      displayName: localized.displayName,
      localizedNames: localized.localizedNames,
      // Weight variants (e.g. "Hiragino Sans GB W3") share localized family names; only the family itself is "common".
      rank: font ? commonFontRank([name]) : undefined,
      resolvedName: font?.fontName,
      embeddedId: font?.id,
      sampleRuns,
      available: Boolean(font),
      ...(!font
        ? {
            reason: resolveFontFilePath(name)
              ? ('unsupported' as const)
              : ('missing' as const),
          }
        : {}),
    });
    if (options.length % 32 === 0) await yieldToApp();
  }
  return options.sort(
    (a, b) =>
      Number(b.available) - Number(a.available) || a.name.localeCompare(b.name),
  );
}

export function isFontAvailable(
  fontName: string,
  context: FontContext = [],
): boolean {
  return Boolean(resolveFace(fontName, context));
}
