export interface TranslationDictionaryEntry {
  source: string;
  target: string;
}

const SEPARATORS = ['=>', '->', '→', '\t', '='];

function splitDictionaryLine(line: string): TranslationDictionaryEntry | null {
  for (const separator of SEPARATORS) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;

    const source = line.slice(0, index).trim();
    const target = line.slice(index + separator.length).trim();
    if (!source || !target) return null;
    return { source, target };
  }

  return null;
}

function sortBySourceLength(
  entries: TranslationDictionaryEntry[],
): TranslationDictionaryEntry[] {
  return [...entries].sort((a, b) => b.source.length - a.source.length);
}

function parseRegexLiteral(
  source: string,
): { pattern: string; flags: string } | null {
  if (!source.startsWith('/')) return null;

  let escaped = false;
  for (let index = 1; index < source.length; index++) {
    const char = source[index];
    if (char === '/' && !escaped) {
      return {
        pattern: source.slice(1, index),
        flags: source.slice(index + 1),
      };
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }

  return null;
}

function normalizeRegexFlags(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

function compileDictionaryRegex(
  entry: TranslationDictionaryEntry,
): RegExp | null {
  const literal = parseRegexLiteral(entry.source);
  const pattern = literal?.pattern ?? entry.source;
  const flags = normalizeRegexFlags(literal?.flags ?? '');

  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function parseTranslationDictionary(
  dictionary?: string | TranslationDictionaryEntry[] | null,
): TranslationDictionaryEntry[] {
  if (!dictionary) return [];

  const parsed =
    typeof dictionary === 'string'
      ? dictionary
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
          .map(splitDictionaryLine)
          .filter((entry): entry is TranslationDictionaryEntry => !!entry)
      : dictionary
          .map((entry) => ({
            source: String(entry?.source || '').trim(),
            target: String(entry?.target || '').trim(),
          }))
          .filter((entry) => entry.source && entry.target);

  const bySource = new Map<string, TranslationDictionaryEntry>();
  parsed.forEach((entry) => {
    bySource.set(entry.source, entry);
  });

  return sortBySourceLength([...bySource.values()]);
}

export function applyTranslationDictionaryToText(
  text: string,
  entries?: TranslationDictionaryEntry[],
): string {
  if (!text || !entries?.length) return text;

  return sortBySourceLength(entries).reduce((output, entry) => {
    if (!entry.source || !entry.target || entry.source === entry.target) {
      return output;
    }
    const regex = compileDictionaryRegex(entry);
    if (!regex) return output;
    return output.replace(regex, () => entry.target);
  }, text);
}

export function applyTranslationDictionaryToResults<
  T extends { targetContent?: string },
>(results: T[], entries?: TranslationDictionaryEntry[]): T[] {
  if (!entries?.length) return results;

  return results.map((result) => {
    if (typeof result.targetContent !== 'string') return result;
    return {
      ...result,
      targetContent: applyTranslationDictionaryToText(
        result.targetContent,
        entries,
      ),
    };
  });
}
