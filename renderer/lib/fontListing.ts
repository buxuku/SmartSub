import pinyin from 'tiny-pinyin';

export interface FontOption {
  name: string;
  /** Localized family name (e.g. 黑体-简) shown next to the English name. */
  displayName?: string;
  localizedNames?: string[];
  /** Position in the main process' common-font order; undefined when uncommon. */
  rank?: number;
  available: boolean;
  reason?: 'missing' | 'unsupported';
  embeddedId?: string;
  sampleRuns?: {
    text: string;
    fontName: string;
    fullName?: string;
    postscriptName?: string;
  }[];
}

export type FontGroup =
  | 'embedded'
  | 'recent'
  | 'common'
  | 'other'
  | 'unavailable';
export type FontRow =
  | { kind: 'header'; group: FontGroup }
  | { kind: 'font'; group: FontGroup; font: FontOption };

const compact = (value: string) =>
  value.toLocaleLowerCase().replace(/\s+/g, '');
const HAS_CJK = /[\u3400-\u9fff]/;

const pinyinKeys = new Map<string, { full: string; initials: string }>();
function pinyinOf(text: string) {
  let keys = pinyinKeys.get(text);
  if (!keys) {
    const syllables = Array.from(text)
      .map((char) =>
        HAS_CJK.test(char) ? pinyin.convertToPinyin(char).toLowerCase() : char,
      )
      .map((syllable) =>
        syllable.toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]/g, ''),
      )
      .filter(Boolean);
    keys = {
      full: compact(syllables.join('')),
      initials: compact(
        syllables.map((syllable) => syllable.charAt(0)).join(''),
      ),
    };
    pinyinKeys.set(text, keys);
  }
  return keys;
}

/** Matches English name, localized names, pinyin and pinyin initials. */
export function fontMatchesQuery(font: FontOption, query: string): boolean {
  const needle = compact(query);
  if (!needle) return true;
  const names = [font.name, font.displayName, ...(font.localizedNames || [])];
  return names.some((name) => {
    if (!name) return false;
    if (compact(name).includes(needle)) return true;
    if (!HAS_CJK.test(name)) return false;
    const keys = pinyinOf(name);
    return keys.full.includes(needle) || keys.initials.includes(needle);
  });
}

/** Order the picker: embedded → recent → common → everything else → unavailable. */
export function organizeFonts(
  fonts: FontOption[],
  { recent, query }: { recent: string[]; query: string },
): FontRow[] {
  const matching = fonts.filter((font) => fontMatchesQuery(font, query));
  const byName = (a: FontOption, b: FontOption) => a.name.localeCompare(b.name);
  const placed = new Set<string>();
  const take = (list: FontOption[]) =>
    list.filter((font) => {
      if (placed.has(font.name)) return false;
      placed.add(font.name);
      return true;
    });
  const embedded = take(
    matching.filter((font) => font.available && font.embeddedId).sort(byName),
  );
  const recentFonts = take(
    recent.flatMap((name) =>
      matching.filter((font) => font.available && font.name === name),
    ),
  );
  const common = take(
    matching
      .filter((font) => font.available && font.rank !== undefined)
      .sort((a, b) => a.rank! - b.rank! || byName(a, b)),
  );
  const other = take(matching.filter((font) => font.available).sort(byName));
  const unavailable = take(
    matching.filter((font) => !font.available).sort(byName),
  );
  const groups: [FontGroup, FontOption[]][] = [
    ['embedded', embedded],
    ['recent', recentFonts],
    ['common', common],
    ['other', other],
    ['unavailable', unavailable],
  ];
  return groups.flatMap(([group, list]) =>
    list.length
      ? [
          { kind: 'header' as const, group },
          ...list.map((font) => ({ kind: 'font' as const, group, font })),
        ]
      : [],
  );
}
